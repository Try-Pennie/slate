// Reading production log LINES, in narrow windows (#3664, #3299).
//
// Three parts, all driven through fakes with no network:
//
//   - #3299: a wide window silently drops rows. On 2026-10-05 the events view returned
//     26 rows for `tag=booking-reminder msg="cycle"` over 25 hours, and 287 when the same
//     question was asked one hour at a time. So the tool splits any window into slices
//     of at most an hour, for counting AND for printing, merges them, and says so.
//   - #3664: two investigations could count lines but not read them. `--lines` prints the
//     matching lines through the API's events view, keeps the positive control rule, and
//     says when the listing is not the whole set rather than letting a short list read as
//     the complete one.
//   - #3915: the count is Cloudflare's ESTIMATE, the sum of each stored row's sample weight,
//     while the listing is the rows it stored. Measured 2026-10-18 15:30 to 16:30 UTC on
//     `confirm answered`: 69 counted, 51 stored and listed, 49 kept at weight 1 and 2 at
//     weight 10. The other 18 were never stored, so no slice, page or retry can list them.
//     The tool reads each row's weight, says the listing is sampled rather than short, and
//     prints the weight on the line so a percentile can be weighted by it.
//
// And the token is never printed, on any path, including an error body that echoes it.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-logs-slices.ts
import {
  sliceWindow,
  SLICE_MS,
  MAX_WINDOW_MS,
  MAX_SLICES,
  EVENTS_LIMIT,
  buildEventsQuery,
  linesFromResponse,
  formatLine,
  buildWeightsQuery,
  weightsFromResponse,
  weightOfPrintedLine,
  mergeJudgements,
  judge,
  searchSliced,
  listLines,
  resolveToken,
  redact,
  TOKEN_ENV,
  TOKEN_MISSING,
  run,
  exitCodeFor,
  CONTROL_NEEDLE,
  type CountQuery,
  type EventsQuery,
  type WeightsQuery,
  type LogLine,
} from "./logs.ts";
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-10-05T00:00:00Z");

// --- Slicing (#3299).
{
  eq(SLICE_MS, HOUR, "the slice is one hour, the size #3299 measured as complete");

  const s = sliceWindow({ fromIso: iso(T0), toIso: iso(T0 + 25 * HOUR) });
  eq(s.length, 25, "a 25 hour window becomes 25 slices");
  eq(s[0].fromIso, iso(T0), "the first slice starts at the window's start");
  eq(s[s.length - 1].toIso, iso(T0 + 25 * HOUR), "the last slice ends at the window's end");
  let contiguous = true;
  for (let i = 1; i < s.length; i++) if (s[i].fromIso !== s[i - 1].toIso) contiguous = false;
  assert(contiguous, "slices are contiguous: each starts where the previous ended, so nothing falls between them");
  assert(
    s.every((x) => Date.parse(x.toIso) - Date.parse(x.fromIso) <= HOUR),
    "no slice is wider than an hour",
  );

  const ragged = sliceWindow({ fromIso: iso(T0), toIso: iso(T0 + 150 * MIN) });
  eq(ragged.length, 3, "a window that is not a whole number of hours gets a short final slice");
  eq(
    Date.parse(ragged[2].toIso) - Date.parse(ragged[2].fromIso),
    30 * MIN,
    "and the short slice is the remainder",
  );

  eq(sliceWindow({ fromIso: iso(T0), toIso: iso(T0 + 20 * MIN) }).length, 1, "a window inside an hour is one slice");
  eq(
    sliceWindow({ fromIso: iso(T0), toIso: iso(T0 + HOUR), sliceMs: 10 * MIN }).length,
    6,
    "a narrower slice can be asked for",
  );

  let threw = false;
  try {
    sliceWindow({ fromIso: iso(T0), toIso: iso(T0 + 4 * HOUR), sliceMs: 2 * HOUR });
  } catch {
    threw = true;
  }
  assert(threw, "a slice WIDER than an hour is refused, since that is the size known to drop rows");

  threw = false;
  try {
    sliceWindow({ fromIso: iso(T0), toIso: iso(T0 + MAX_WINDOW_MS + MIN) });
  } catch {
    threw = true;
  }
  assert(threw, "a window longer than the 7 day retention is refused rather than sliced into empty hours");

  // Each slice is at least one request, made one after another, so the NUMBER of slices is
  // the cost. A tiny slice over a long window would be millions of sequential calls.
  eq(MAX_SLICES, 168, "at most 168 slices, a full 7 days at one hour each");
  eq(
    sliceWindow({ fromIso: iso(T0), toIso: iso(T0 + MAX_WINDOW_MS) }).length,
    168,
    "so the widest window at the default slice is allowed",
  );
  threw = false;
  try {
    sliceWindow({ fromIso: iso(T0), toIso: iso(T0 + 7 * 24 * HOUR), sliceMs: 0.001 * MIN });
  } catch {
    threw = true;
  }
  assert(threw, "a slice under a minute is refused");
  threw = false;
  try {
    sliceWindow({ fromIso: iso(T0), toIso: iso(T0 + 2 * 24 * HOUR), sliceMs: 10 * MIN });
  } catch (e) {
    threw = /narrow the window/.test(String(e));
  }
  assert(threw, "more than 168 slices is refused before any request, saying to narrow the window");
}

// --- The events query shape.
{
  const q = buildEventsQuery({ needle: "tag=booking-api", fromIso: iso(T0), toIso: iso(T0 + HOUR) });
  eq(q.view, "events", "lists through the events view, which the raw API serves for app rows");
  eq(q.limit, EVENTS_LIMIT, "asks for the most rows one request may return");
  assert(typeof q.timeframe.from === "number" && q.timeframe.to === T0 + HOUR, "timeframe in Unix ms");
  const keys = q.parameters.filters.map((f) => f.key);
  assert(keys.includes("message") && !keys.includes("$metadata.message"), "filters on the bare message field");
  assert(!keys.some((k) => /level/.test(k)), "never filters on level, which hides console.log lines");
}

// --- Reading lines out of an events response.
{
  const body = {
    result: {
      events: {
        events: [
          {
            $metadata: { id: "b", level: "error" },
            timestamp: T0 + 2 * MIN,
            source: { message: 'slate tag=booking msg="insert failed"' },
          },
          { $metadata: { id: "a" }, timestamp: T0 + MIN, source: { message: 'slate tag=booking msg="cycle"' } },
          { $metadata: { id: "c" }, timestamp: T0 + 3 * MIN, source: { unexpected: true } },
        ],
      },
    },
  };
  const lines = linesFromResponse(body);
  eq(lines.length, 3, "every event becomes a line, including one whose text cannot be read");
  eq(lines[0].message, 'slate tag=booking msg="insert failed"', "the line text comes from source.message");
  eq(lines[0].level, "error", "the level is read when Cloudflare recorded one");
  eq(lines[1].level, null, "a console.log line carries no level, reported as null rather than invented");
  eq(lines[2].message, null, "an event with no readable text is kept as unreadable, never dropped");

  const text = formatLine(lines[0]);
  assert(text.includes(iso(T0 + 2 * MIN)), "a printed line carries its timestamp");
  assert(text.includes("error") && text.includes('msg="insert failed"'), "and its level and text");
  assert(formatLine(lines[1]).includes(" - "), "a line with no level prints a dash placeholder");
  assert(/could not be read/.test(formatLine(lines[2])), "an unreadable event prints as unreadable, not as a blank");

  let threw = false;
  try {
    linesFromResponse({ result: { calculations: [] } });
  } catch {
    threw = true;
  }
  assert(threw, "a response with no events list throws, rather than reading as zero lines");
}

// --- Merging per slice judgements.
{
  const live = (n: number) => judge({ needleCount: n, controlCount: 60, controlNewestMs: T0, windowEndMs: T0 });
  const dead = judge({ needleCount: 0, controlCount: 0 });

  const allAbsent = mergeJudgements([live(0), live(0), live(0)]);
  assert(allAbsent.verdict === "absent" && allAbsent.trustworthy, "every slice a trustworthy absence merges to absence");
  eq(allAbsent.controlCount, 180, "control counts are summed");

  const hit = mergeJudgements([live(0), live(4), live(8)]);
  eq(hit.needleCount, 12, "needle counts are summed across slices");
  assert(hit.verdict === "present" && exitCodeFor(hit) === 0, "and any hit makes the whole window present");

  const gap = mergeJudgements([live(0), dead, live(0)]);
  assert(
    gap.verdict === "unverifiable" && exitCodeFor(gap) === 2,
    "ONE slice with a dead control makes an absence over the whole window unverifiable",
  );
  assert(/1 of 3/.test(gap.reason), "and says how many slices could not be checked");

  const hitWithGap = mergeJudgements([live(3), dead]);
  assert(
    hitWithGap.verdict === "present" && hitWithGap.trustworthy,
    "a hit in a slice whose control is live stays a hit beside an unverifiable slice",
  );
  assert(/at least/i.test(hitWithGap.reason), "but the count is called a floor, since one slice could not be read");

  const lagged = judge({
    needleCount: 0,
    controlCount: 60,
    controlNewestMs: T0 - 40 * MIN,
    windowEndMs: T0,
    freshnessMode: "warn",
  });
  const stale = mergeJudgements([live(0), lagged]);
  eq(stale.staleControlMinutes, 40, "a lagging slice's staleness survives the merge");
}

// --- A fake Cloudflare: counts and events per hour, keyed on the timeframe.
type Fake = {
  count: (q: CountQuery) => Promise<{ count: number; newestMs: number | null }>;
  events: (q: EventsQuery) => Promise<LogLine[]>;
  weights: (q: WeightsQuery) => Promise<Map<string, number>>;
  asked: { kind: string; needle: string; from: number; to: number }[];
};
function fakeCloudflare(opts: {
  needlePerHour: number;
  /** Events the listing returns per slice; defaults to the count. */
  listedPerHour?: number;
  deadControlHour?: number;
}): Fake {
  const asked: Fake["asked"] = [];
  const needleOf = (q: { parameters: { filters: { key: string; value: string }[] } }) =>
    q.parameters.filters.find((f) => f.key === "message")!.value;
  return {
    asked,
    count: async (q) => {
      const needle = needleOf(q);
      asked.push({ kind: "count", needle, from: q.timeframe.from, to: q.timeframe.to });
      const hour = Math.floor((q.timeframe.from - T0) / HOUR);
      if (needle === CONTROL_NEEDLE) {
        if (hour === opts.deadControlHour) return { count: 0, newestMs: null };
        return { count: 60, newestMs: q.timeframe.to - MIN };
      }
      return { count: opts.needlePerHour, newestMs: opts.needlePerHour ? q.timeframe.to - MIN : null };
    },
    events: async (q) => {
      asked.push({ kind: "events", needle: needleOf(q), from: q.timeframe.from, to: q.timeframe.to });
      const n = opts.listedPerHour ?? opts.needlePerHour;
      return Array.from({ length: n }, (_, i) => ({
        id: `${q.timeframe.from}-${i}`,
        // Newest first, the way a log listing usually comes back, so sorting is exercised.
        timestampMs: q.timeframe.to - (i + 1) * MIN,
        level: "info",
        message: `slate tag=booking-reminder msg="cycle" n=${i}`,
      }));
    },
    // Every counted row was stored at weight 1: an unsampled hour.
    weights: async (q) => {
      asked.push({ kind: "weights", needle: needleOf(q), from: q.timeframe.from, to: q.timeframe.to });
      return new Map(Array.from({ length: opts.needlePerHour }, (_, i) => [`${q.timeframe.from}-${i}`, 1]));
    },
  };
}

// --- Counting through slices, end to end.
{
  const cf = fakeCloudflare({ needlePerHour: 12 });
  const r = await searchSliced({
    needle: 'tag=booking-reminder msg="cycle"',
    control: CONTROL_NEEDLE,
    fromIso: iso(T0),
    toIso: iso(T0 + 25 * HOUR),
    query: cf.count,
  });
  eq(r.slices.length, 25, "a 25 hour count runs as 25 one hour slices");
  eq(r.judgement.needleCount, 300, "and sums them (12 an hour over 25 hours)");
  const counts = cf.asked.filter((a) => a.kind === "count");
  eq(counts.length, 50, "needle AND control are counted in every slice");
  assert(
    counts.every((a) => a.to - a.from <= HOUR),
    "no request asks Cloudflare for more than an hour",
  );
  // The control must be measured over the SAME slice as the needle, or it is no control.
  let paired = true;
  for (let i = 0; i < counts.length; i += 2) {
    if (counts[i].from !== counts[i + 1].from || counts[i].to !== counts[i + 1].to) paired = false;
  }
  assert(paired, "each slice's control is measured over exactly that slice");
}

// --- Listing lines through slices.
{
  const cf = fakeCloudflare({ needlePerHour: 3 });
  const r = await listLines({
    needle: "tag=booking-reminder",
    control: CONTROL_NEEDLE,
    fromIso: iso(T0),
    toIso: iso(T0 + 3 * HOUR),
    query: cf.count,
    events: cf.events,
    weights: cf.weights,
  });
  eq(r.lines.length, 9, "lines from every slice are merged");
  let sorted = true;
  for (let i = 1; i < r.lines.length; i++) {
    if ((r.lines[i].timestampMs ?? 0) < (r.lines[i - 1].timestampMs ?? 0)) sorted = false;
  }
  assert(sorted, "and printed oldest first, whatever order each slice returned them in");
  eq(r.incomplete.length, 0, "a listing that matches the count in every slice is complete");
  eq(r.sampled.length, 0, "and an hour stored at weight 1 throughout is not sampled");
  assert(r.judgement.verdict === "present", "and the verdict still comes from the controlled count");
}
{
  // The events view returning FEWER lines than Cloudflare STORED is the #3299 shape inside a
  // slice, and it is a fault of the listing, not of sampling.
  const cf = fakeCloudflare({ needlePerHour: 5, listedPerHour: 2 });
  const r = await listLines({
    needle: "tag=x",
    control: CONTROL_NEEDLE,
    fromIso: iso(T0),
    toIso: iso(T0 + 2 * HOUR),
    query: cf.count,
    events: cf.events,
    weights: cf.weights,
  });
  eq(r.incomplete.length, 2, "a slice that listed fewer lines than Cloudflare stored is reported incomplete");
  assert(
    /listed 2 of the 5 lines Cloudflare stored/.test(r.incomplete[0]?.reason ?? ""),
    `naming how many it listed of how many were stored (got ${r.incomplete[0]?.reason})`,
  );
  eq(
    cf.asked.filter((a) => a.kind === "events").length,
    4,
    "a short listing is asked for once more before it is reported, and no more than once",
  );
}
{
  // A slice whose listing filled the request limit may have been cut off.
  const cf = fakeCloudflare({ needlePerHour: EVENTS_LIMIT });
  const r = await listLines({
    needle: "tag=x",
    control: CONTROL_NEEDLE,
    fromIso: iso(T0),
    toIso: iso(T0 + HOUR),
    query: cf.count,
    events: cf.events,
    weights: cf.weights,
  });
  eq(r.incomplete.length, 1, "a slice that hit the request limit is reported as possibly truncated");
  assert(/--slice-minutes/.test(r.incomplete[0]?.reason ?? ""), "and names the remedy, a narrower slice");
}

{
  // A row stamped exactly on the boundary between two slices comes back from BOTH, in the
  // count and in the listing. The listing keeps it once by id; the count must agree, or the
  // printed list is one shorter than the count with nothing flagged.
  const BOUNDARY_ID = "row-on-the-boundary";
  const count: Parameters<typeof listLines>[0]["query"] = async (q) => {
    const needle = q.parameters.filters.find((f) => f.key === "message")!.value;
    if (needle === CONTROL_NEEDLE) return { count: 60, newestMs: q.timeframe.to - MIN };
    return { count: 2, newestMs: q.timeframe.to - MIN };
  };
  const events: Parameters<typeof listLines>[0]["events"] = async (q) => {
    const first = q.timeframe.from === T0;
    const own = { id: `own-${q.timeframe.from}`, timestampMs: q.timeframe.from + 30 * MIN, level: "info", message: "slate tag=x" };
    const shared = { id: BOUNDARY_ID, timestampMs: T0 + HOUR, level: "info", message: "slate tag=x boundary" };
    return first ? [own, shared] : [shared, own];
  };
  const weights: Parameters<typeof listLines>[0]["weights"] = async (q) =>
    new Map([[`own-${q.timeframe.from}`, 1], [BOUNDARY_ID, 1]]);
  const r = await listLines({ needle: "tag=x", control: CONTROL_NEEDLE, fromIso: iso(T0), toIso: iso(T0 + 2 * HOUR), query: count, events, weights });
  eq(r.lines.length, 3, "the boundary row is printed once");
  eq(r.judgement.needleCount, 3, "and counted once, so the count matches the rows it describes");
  assert(/found 3 matching/.test(r.judgement.reason), "the verdict's sentence carries the corrected count too");
  eq(r.slices[0].judgement.needleCount + r.slices[1].judgement.needleCount, 3, "the per slice counts printed above it agree");
  eq(r.incomplete.length, 0, "and a duplicate is not mistaken for a missing line");
}
{
  // The later slice's ONLY row is the repeat: once it is taken out, that slice is an absence,
  // and its verdict and sentence must say so rather than "present" over a count of zero.
  const shared = { id: "only-row", timestampMs: T0 + HOUR, level: "info", message: "slate tag=x" };
  const count: Parameters<typeof listLines>[0]["query"] = async (q) => {
    const needle = q.parameters.filters.find((f) => f.key === "message")!.value;
    if (needle === CONTROL_NEEDLE) return { count: 60, newestMs: q.timeframe.to - MIN };
    return { count: 1, newestMs: T0 + HOUR };
  };
  const events: Parameters<typeof listLines>[0]["events"] = async () => [shared];
  const weights: Parameters<typeof listLines>[0]["weights"] = async () => new Map([["only-row", 1]]);
  const r = await listLines({ needle: "tag=x", control: CONTROL_NEEDLE, fromIso: iso(T0), toIso: iso(T0 + 2 * HOUR), query: count, events, weights });
  const later = r.slices[1].judgement;
  eq(later.needleCount, 0, "the slice holding only the repeat counts nothing");
  eq(later.verdict, "absent", "and is judged an absence, not left reading as present");
  assert(!/found 1 matching/.test(later.reason), "with a sentence that no longer claims the row");
  eq(r.judgement.needleCount, 1, "while the window still holds the one row, once");
  eq(r.judgement.verdict, "present", "and is present");
}

// --- Cloudflare's sampling (#3915): the count is an estimate, the listing is what was stored.
{
  const q = buildWeightsQuery({ needle: "tag=x", fromIso: iso(T0), toIso: iso(T0 + HOUR) });
  eq(q.view, "calculations", "each row's weight is read through the calculations view");
  eq(
    q.parameters.groupBys,
    [{ type: "string", value: "$metadata.id" }],
    "grouped by row id, so each group is one stored row and its count is that row's sample weight",
  );
  // Measured 2026-10-20: with no `parameters.limit` the API returns 10 groups, and the
  // request's top level `limit` does not change that.
  eq(q.parameters.limit, EVENTS_LIMIT, "asks inside `parameters` for as many groups as one listing returns rows");
  const keys = q.parameters.filters.map((f) => f.key);
  assert(keys.includes("message") && !keys.includes("$metadata.message"), "filters on the bare message field");
  assert(!keys.some((k) => /level/.test(k)), "never filters on level");

  const group = (id: string, value: number) => ({ groups: [{ key: "$metadata.id", value: id }], value, count: value });
  const m = weightsFromResponse({ result: { calculations: [{ aggregates: [group("a", 1), group("b", 10)] }] } });
  eq(m.size, 2, "one entry per stored row");
  eq(m.get("b"), 10, "carrying the row's weight: the number of lines it stands for");
  eq(weightsFromResponse({ result: { calculations: [{ aggregates: [] }] } }).size, 0, "no stored row reads as an empty map");
  eq(
    weightsFromResponse({ result: { calculations: [{ aggregates: [{ value: 0 }] }] } }).size,
    0,
    "and so does the ungrouped zero some responses carry",
  );
  let threw = false;
  try {
    weightsFromResponse({ result: {} });
  } catch {
    threw = true;
  }
  assert(threw, "a response with no aggregates throws rather than reading as no rows");
  threw = false;
  try {
    weightsFromResponse({ result: { calculations: [{ aggregates: [{ value: 3 }] }] } });
  } catch {
    threw = true;
  }
  assert(threw, "a counted group with no row id throws, since its rows could not be told apart");
}
{
  // The measured slice, 2026-10-18 15:30 to 16:30 UTC: counted 69, stored and listed 51, of
  // which 49 at weight 1 and 2 at weight 10.
  const ids = Array.from({ length: 51 }, (_, i) => `r${i}`);
  const weightOf = (i: number) => (i >= 49 ? 10 : 1);
  let listings = 0;
  const r = await listLines({
    needle: 'msg="confirm answered"',
    control: CONTROL_NEEDLE,
    fromIso: iso(T0),
    toIso: iso(T0 + HOUR),
    query: async (q) => {
      const needle = q.parameters.filters.find((f) => f.key === "message")!.value;
      return { count: needle === CONTROL_NEEDLE ? 60 : 69, newestMs: q.timeframe.to - MIN };
    },
    events: async () => {
      listings++;
      return ids.map((id, i) => ({ id, timestampMs: T0 + i * MIN, level: "info", message: `slate msg="confirm answered" n=${i}` }));
    },
    weights: async () => new Map(ids.map((id, i) => [id, weightOf(i)])),
  });
  eq(listings, 1, "a listing holding every stored row is not asked for again");
  eq(r.incomplete.length, 0, "listing every row Cloudflare stored is NOT a short listing, though it is under the count");
  eq(r.sampled.length, 1, "it is reported as sampled instead");
  eq(r.sampled[0]?.stored, 51, "naming how many rows Cloudflare stored");
  eq(r.sampled[0]?.standsFor, 69, "and how many they stand for");
  eq(r.lines.filter((l) => l.weight === 10).length, 2, "each line carries its own weight");
  eq(
    r.lines.reduce((s, l) => s + (l.weight ?? 0), 0),
    69,
    "and the weights add up to the count, so a weighted figure describes the whole window",
  );
  eq(r.judgement.needleCount, 69, "the verdict's count is still Cloudflare's");
}
{
  // A listing that came back short once and whole on asking again: measured 2026-10-20, one
  // hour listed 4 of the 19 rows it stored, and 19 on every later ask.
  const ids = ["a", "b", "c"];
  let listings = 0;
  const r = await listLines({
    needle: "tag=x",
    control: CONTROL_NEEDLE,
    fromIso: iso(T0),
    toIso: iso(T0 + HOUR),
    query: async (q) => ({
      count: q.parameters.filters.find((f) => f.key === "message")!.value === CONTROL_NEEDLE ? 60 : 3,
      newestMs: q.timeframe.to - MIN,
    }),
    events: async () => {
      listings++;
      const n = listings === 1 ? 1 : 3;
      return ids.slice(0, n).map((id, i) => ({ id, timestampMs: T0 + i * MIN, level: "info", message: `slate tag=x ${id}` }));
    },
    weights: async () => new Map(ids.map((id) => [id, 1])),
  });
  eq(listings, 2, "a listing short of the stored rows is asked for again");
  eq(r.incomplete.length, 0, "and a whole second answer is a whole listing");
  eq(r.lines.length, 3, "with every row printed once");
}
{
  // A sampled slice whose listing holds a row the weights do not: its weight is unknown, and
  // a figure weighted over it would be guessed, so the slice is incomplete.
  const r = await listLines({
    needle: "tag=x",
    control: CONTROL_NEEDLE,
    fromIso: iso(T0),
    toIso: iso(T0 + HOUR),
    query: async (q) => ({
      count: q.parameters.filters.find((f) => f.key === "message")!.value === CONTROL_NEEDLE ? 60 : 11,
      newestMs: q.timeframe.to - MIN,
    }),
    events: async () =>
      ["a", "b", "late"].map((id, i) => ({ id, timestampMs: T0 + i * MIN, level: "info", message: `slate tag=x ${id}` })),
    weights: async () => new Map([["a", 1], ["b", 10]]),
  });
  eq(r.lines.find((l) => l.id === "late")?.weight, null, "a sampled slice's row with no weight reads as unknown, never 1");
  eq(r.incomplete.length, 1, "and the slice is incomplete");
  assert(/weight/.test(r.incomplete[0]?.reason ?? ""), `saying it is the weight that is missing (got ${r.incomplete[0]?.reason})`);
}
{
  // The same in a slice stored at weight 1 throughout: a row that landed between the two
  // requests can only have been stored unsampled like its neighbours, so it is weight 1.
  const r = await listLines({
    needle: "tag=x",
    control: CONTROL_NEEDLE,
    fromIso: iso(T0),
    toIso: iso(T0 + HOUR),
    query: async (q) => ({
      count: q.parameters.filters.find((f) => f.key === "message")!.value === CONTROL_NEEDLE ? 60 : 2,
      newestMs: q.timeframe.to - MIN,
    }),
    events: async () =>
      ["a", "b", "late"].map((id, i) => ({ id, timestampMs: T0 + i * MIN, level: "info", message: `slate tag=x ${id}` })),
    weights: async () => new Map([["a", 1], ["b", 1]]),
  });
  eq(r.lines.find((l) => l.id === "late")?.weight, 1, "an unsampled slice's late row is weight 1");
  eq(r.incomplete.length, 0, "and nothing is incomplete");
}
{
  // The weight is printed on the line, between the level and the text, only when it is not 1.
  const base = { id: "x", timestampMs: T0, level: "info", message: 'slate tag=booking msg="confirm answered" response_ms=900' };
  const ten = formatLine({ ...base, weight: 10 });
  assert(ten.includes("  info  weight=10  slate tag=booking"), `a weighted line prints weight=10 before the text (got ${ten})`);
  assert(!formatLine({ ...base, weight: 1 }).includes("weight="), "a line at weight 1 prints as before");
  assert(!formatLine(base).includes("weight="), "and so does a line with no weight read");
  assert(formatLine({ ...base, weight: null }).includes("  weight=unknown  "), "an unknown weight is printed as unknown");
  eq(weightOfPrintedLine(ten), 10, "the printed weight reads back");
  eq(weightOfPrintedLine(formatLine(base)), 1, "a line printed with no weight reads back as 1");
  eq(weightOfPrintedLine(formatLine({ ...base, weight: null })), null, "and an unknown one as null");
  eq(
    weightOfPrintedLine(formatLine({ ...base, timestampMs: null, level: null, weight: 4 })),
    4,
    "including on a line with no timestamp and no level",
  );
  // A field in the line's own text named weight is the line's, not the tool's.
  eq(
    weightOfPrintedLine(formatLine({ ...base, message: "slate tag=x weight=99" })),
    1,
    "a weight= inside the text is not read as the line's weight",
  );
}

// --- The token: where it comes from, and that it is never printed.
{
  const TOKEN = "cfut_SECRET_value_never_print_9f3a";
  eq(
    resolveToken({ env: { CLOUDFLARE_API_TOKEN: ` ${TOKEN} ` }, readFile: () => null }),
    TOKEN,
    "the environment's token is used, trimmed",
  );
  eq(
    resolveToken({ env: { CLOUDFLARE_LOGS_READ_TOKEN: TOKEN, CLOUDFLARE_API_TOKEN: "other" }, readFile: () => null }),
    TOKEN,
    "the logs token's own name wins over the general Cloudflare one",
  );
  eq(
    resolveToken({
      env: {},
      readFile: () => `SUPABASE_SECRET_KEY=other\nCLOUDFLARE_LOGS_READ_TOKEN="${TOKEN}"\n`,
    }),
    TOKEN,
    "with none in the environment, .env.local is read for that one name",
  );
  // Wrangler 4 loads `.env` AND `.env.local` into its own environment on every command
  // (getDefaultEnvFiles in wrangler 4.127.1) and authenticates with CLOUDFLARE_API_TOKEN when
  // that is set. A read only logs token stored in `.env.local` under that name would replace
  // the OAuth login for every `wrangler tail` and deploy run from the checkout, and they would
  // fail. So the file is read for a name wrangler does not know, and never for that one.
  eq(TOKEN_ENV, "CLOUDFLARE_LOGS_READ_TOKEN", "the .env.local name is one wrangler never reads");
  assert(
    (TOKEN_ENV as string) !== "CLOUDFLARE_API_TOKEN" && !TOKEN_ENV.startsWith("CF_"),
    "and is not CLOUDFLARE_API_TOKEN or a deprecated CF_ alias wrangler would pick up",
  );
  eq(
    resolveToken({ env: {}, readFile: () => `CLOUDFLARE_API_TOKEN=${TOKEN}\n` }),
    null,
    "a CLOUDFLARE_API_TOKEN line in .env.local is NOT used, so nobody is taught to put one there",
  );
  eq(resolveToken({ env: { CLOUDFLARE_API_TOKEN: "  " }, readFile: () => null }), null, "a blank token is absent");
  eq(redact(`Bearer ${TOKEN} rejected`, TOKEN), "Bearer [redacted] rejected", "redact removes the token from text");

  type Captured = { out: string[]; err: string[]; requests: { auth: string | null; body: unknown }[] };
  const drive = async (
    argv: string[],
    respond: (body: { view: string; parameters: { filters: { key: string; value: string }[] }; timeframe: { from: number; to: number } }) => Response,
    env: Record<string, string | undefined> = { CLOUDFLARE_API_TOKEN: TOKEN },
  ): Promise<Captured & { code: number }> => {
    const c: Captured = { out: [], err: [], requests: [] };
    const code = await run(argv, {
      env,
      readFile: () => null,
      nowMs: T0 + 3 * HOUR,
      out: (l) => c.out.push(l),
      err: (l) => c.err.push(l),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const headers = new Headers(init?.headers);
        c.requests.push({ auth: headers.get("authorization"), body });
        return respond(body);
      },
    });
    return { ...c, code };
  };
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  const healthy = (b: { view: string; parameters: { filters: { key: string; value: string }[] }; timeframe: { from: number; to: number } }) => {
    const needle = b.parameters.filters.find((f) => f.key === "message")!.value;
    if (b.view === "events") {
      return json({
        result: {
          events: {
            events: [
              { $metadata: { id: `e${b.timeframe.from}` }, timestamp: b.timeframe.from + MIN, source: { message: `slate ${needle} msg="seen"` } },
            ],
          },
        },
      });
    }
    const n = needle === CONTROL_NEEDLE ? 60 : 1;
    if ((b as { parameters: { groupBys?: unknown[] } }).parameters.groupBys?.length) {
      return json({ result: { calculations: [{ aggregates: [{ groups: [{ key: "$metadata.id", value: `e${b.timeframe.from}` }], value: n }] }] } });
    }
    const t = new Date(b.timeframe.to - MIN).toISOString().slice(0, 19).replace("T", " ");
    return json({ result: { calculations: [{ aggregates: [{ value: n }], series: [{ time: t, data: [{ value: n }] }] }] } });
  };
  const noToken = (c: Captured) => [...c.out, ...c.err].every((l) => !l.includes(TOKEN));

  const ok = await drive(["tag=booking", "--lines", "--minutes", "150"], healthy);
  assert(
    ok.requests.length > 0 && ok.requests.every((r) => r.auth === `Bearer ${TOKEN}`),
    "positive control: the token really was sent, so the absence checks below mean something",
  );
  eq(ok.code, 0, "lines found with a live control exits 0");
  assert(ok.out.some((l) => l.includes('msg="seen"')), "the matching lines are printed");
  assert(
    [...ok.out, ...ok.err].some((l) => /3 slices/.test(l) && /#3299/.test(l)),
    "the output says the window was split, and why",
  );
  assert(
    ok.requests.every((r) => {
      const b = r.body as { timeframe: { from: number; to: number } };
      return b.timeframe.to - b.timeframe.from <= HOUR;
    }),
    "no request in a 150 minute run asks for more than an hour",
  );
  assert(noToken(ok), "a successful run prints no token");

  const refused = await drive(["tag=booking", "--lines"], () =>
    new Response(`{"errors":[{"message":"token ${TOKEN} lacks permission"}]}`, { status: 403 }),
  );
  eq(refused.code, 2, "an HTTP refusal exits with the do not trust me code");
  assert(refused.err.some((l) => /403/.test(l)), "and names the status");
  assert(noToken(refused), "an error body that ECHOES the token is printed with it redacted");

  const crashed = await drive(["tag=booking"], () => {
    throw new Error(`connect failed for Bearer ${TOKEN}`);
  });
  eq(crashed.code, 2, "a thrown fetch exits 2");
  assert(noToken(crashed), "and a thrown message carrying the token is redacted too");

  const missing = await drive(["tag=booking"], healthy, {});
  eq(missing.code, 2, "no token anywhere exits 2 before anything is queried");
  eq(missing.requests.length, 0, "and sends no request");
  assert(
    missing.err.some((l) => /CLOUDFLARE_LOGS_READ_TOKEN/.test(l) && /\.env\.local/.test(l) && /cloudflare-platform-notes/.test(l)),
    "and says where the token goes and where the steps to create one are",
  );
  {
    // The section it names must be a real heading in that doc, or the pointer leads nowhere.
    const named = TOKEN_MISSING.match(/cloudflare-platform-notes\.md, under "([^"]+)"/)?.[1];
    assert(named !== undefined, "the token message names a section of the platform notes");
    const headings = readFileSync(new URL("../docs/cloudflare-platform-notes.md", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) => l.replace(/^#{1,6} /, "").trim());
    assert(headings.includes(named ?? ""), `the section it names ("${named}") is a heading in that doc`);
  }

  const dead = await drive(["tag=booking", "--lines", "--minutes", "60"], (b) => {
    if (b.view === "events") return json({ result: { events: { events: [] } } });
    return json({ result: { calculations: [{ aggregates: [{ value: 0 }], series: [] }] } });
  });
  eq(dead.code, 2, "printing nothing with a dead control is UNVERIFIABLE, never an absence");
  assert(dead.err.some((l) => /UNVERIFIABLE/.test(l)), "and says so");

  const short = await drive(["tag=booking", "--lines", "--minutes", "60"], (b) => {
    if (b.view === "events") return json({ result: { events: { events: [] } } });
    return healthy(b);
  });
  eq(short.code, 3, "lines counted but not listed exits 3, its own code: found, and the listing is incomplete");
  assert(short.err.some((l) => /incomplete/i.test(l)), "and warns that the printed list is not the whole set");

  // #3915: a sampled window. Cloudflare counts 12, stores three rows, one of them at weight 10.
  type Body = Parameters<typeof healthy>[0] & { parameters: { groupBys?: unknown[] } };
  const sampled = (b: Body) => {
    const needle = b.parameters.filters.find((f) => f.key === "message")!.value;
    if (needle === CONTROL_NEEDLE) return healthy(b);
    const rows = [
      { id: "s1", w: 1 },
      { id: "s2", w: 1 },
      { id: "s3", w: 10 },
    ];
    if (b.view === "events") {
      const events = rows.map((r, i) => ({
        $metadata: { id: r.id },
        timestamp: b.timeframe.from + (i + 1) * MIN,
        source: { message: `slate ${needle} n=${i}` },
      }));
      return json({ result: { events: { events } } });
    }
    if (b.parameters.groupBys?.length) {
      const aggregates = rows.map((r) => ({ groups: [{ key: "$metadata.id", value: r.id }], value: r.w }));
      return json({ result: { calculations: [{ aggregates }] } });
    }
    const t = new Date(b.timeframe.to - MIN).toISOString().slice(0, 19).replace("T", " ");
    return json({ result: { calculations: [{ aggregates: [{ value: 12 }], series: [{ time: t, data: [{ value: 12 }] }] }] } });
  };
  const samp = await drive(["tag=booking", "--lines", "--minutes", "60"], sampled);
  eq(samp.code, 4, "every stored line listed in a sampled window exits 4, its own code, never 3");
  assert(samp.out.some((l) => /  weight=10  /.test(l)), "the line Cloudflare kept 1 in 10 of is printed with weight=10");
  assert(
    samp.out.some((l) => /^SAMPLED: /.test(l) && /stored 3 /.test(l) && /12 counted/.test(l)),
    `stdout says how many were stored of how many counted (got ${samp.out.join(" | ")})`,
  );
  assert(
    ![...samp.out, ...samp.err].some((l) => /missing from what is printed|narrower --slice-minutes/.test(l)),
    "and does not send the reader to narrow the slices, which can never list a line that was not stored",
  );
  const sampledAndShort = await drive(["tag=booking", "--lines", "--minutes", "60"], (b) =>
    b.view === "events" && b.parameters.filters.find((f) => f.key === "message")!.value !== CONTROL_NEEDLE
      ? json({ result: { events: { events: [] } } })
      : sampled(b),
  );
  eq(sampledAndShort.code, 3, "a sampled window whose listing is also short exits 3: the shortfall is the one to act on");

  const tooWide = await drive(["tag=booking", "--slice-minutes", "120"], healthy);
  eq(tooWide.code, 2, "a slice wider than an hour is refused at the command line");
  eq(tooWide.requests.length, 0, "before any request");

  const between = await drive(
    ["tag=booking", "--from", iso(T0), "--to", iso(T0 + 30 * MIN)],
    healthy,
  );
  eq(between.code, 0, "an explicit --from and --to window works");

  // --from fixes the start, so a --minutes beside it would be silently ignored; the caller
  // would get a window they did not ask for. Refused, naming both flags.
  const both = await drive(["tag=booking", "--from", iso(T0), "--minutes", "30"], healthy);
  eq(both.code, 2, "--minutes together with --from is refused");
  eq(both.requests.length, 0, "before any request");
  assert(both.err.some((l) => /--minutes/.test(l) && /--from/.test(l)), "naming the two flags that conflict");
  assert(
    between.requests.every((r) => (r.body as { timeframe: { from: number } }).timeframe.from === T0),
    "and is the window queried",
  );
}

finish();

// What each booker OFFERS during the pilot split (#2927).
//
// A booking rate difference between the halves can come from what each system
// offered rather than from the booker, so every quarter hour the monitor lane
// records, for the Low tier, each system's earliest offered time and how many times
// it offers in the next 24 hours. The thing that must never happen is a failed read
// stored as "offered nothing": that reads as cal.com (or Slate) being empty, which is
// the one conclusion a failure cannot support (L90, L215).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pilot-offers.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  PILOT_OFFER_INTERVAL_MS,
  PILOT_OFFER_TIME_ZONE,
  pilotOfferSampleDue,
  offerSummary,
  readCalcomRoutedSlots,
  runPilotOfferSample,
  summarisePilotOffers,
  pilotOffersReportLines,
  readPilotOffersForReport,
  type PilotOfferRow,
} from "../src/lib/monitor/pilot-offers.ts";

const NOW = Date.parse("2026-10-01T13:00:00.000Z");
const at = (h: number, m = 0) => new Date(NOW + h * 3_600_000 + m * 60_000).toISOString();

// --- the summary of one list of offered times ---------------------------------
{
  const s = offerSummary([at(26), at(1), at(3), at(-1), at(23, 59)], NOW);
  eq(s.earliestOfferedAt, at(1), "the earliest time still ahead is the first offer");
  eq(s.offered24h, 3, "only times inside the next 24 hours are counted, past ones never");
}
{
  const s = offerSummary([], NOW);
  eq(s, { earliestOfferedAt: null, offered24h: 0 }, "a system that answered with nothing offered nothing");
}
{
  let threw = false;
  try {
    offerSummary(["not a time"], NOW);
  } catch {
    threw = true;
  }
  assert(threw, "an unreadable time is refused rather than dropped, or a broken answer would read as fewer times");
}

// --- cal.com's routed answer ---------------------------------------------------
{
  const read = readCalcomRoutedSlots(200, {
    eventTypeId: 1314152,
    slots: { "2026-10-01": [{ start: at(2) }, { start: at(1) }], "2026-10-02": [{ start: at(20) }] },
  });
  assert(read.ok, "a 200 with slots by day is read");
  if (read.ok) eq(read.times.sort(), [at(1), at(2), at(20)], "and every day's times are flattened into one list");
}
{
  const read = readCalcomRoutedSlots(200, { eventTypeId: 1314152, slots: {} });
  assert(read.ok && read.times.length === 0, "a 200 with no slots is a real answer of none");
}
{
  const refused = readCalcomRoutedSlots(429, undefined);
  eq(refused, { ok: false, reason: "cal.com answered 429" }, "a refused call is a failure with its status, never an empty offer");
  const reshaped = readCalcomRoutedSlots(200, { eventTypeId: 1314152 });
  eq(reshaped, { ok: false, reason: "cal.com answered with no slots field" }, "a reshaped answer is a failure, never an empty offer");
  const badItem = readCalcomRoutedSlots(200, { slots: { "2026-10-01": [{ begins: at(1) }] } });
  eq(badItem, { ok: false, reason: "cal.com answered a slot with no start time" }, "a slot we cannot read fails the whole reading");
}

// --- when a sample is due --------------------------------------------------------
{
  // The lane ticks every five minutes, so a quarter hour is judged with half a tick
  // of slack: without it, a tick that lands a second early waits until the next one
  // and the samples drift to every twenty minutes.
  assert(pilotOfferSampleDue(null, NOW), "with no sample yet, one is due");
  assert(!pilotOfferSampleDue(NOW - 10 * 60_000, NOW), "ten minutes after the last, not yet");
  assert(pilotOfferSampleDue(NOW - (PILOT_OFFER_INTERVAL_MS - 60_000), NOW), "a tick a minute early still samples");
  assert(pilotOfferSampleDue(NOW - 20 * 60_000, NOW), "twenty minutes after the last, due");
}

// --- one sample ------------------------------------------------------------------
function deps(over: Partial<Parameters<typeof runPilotOfferSample>[0]> = {}) {
  const inserted: PilotOfferRow[][] = [];
  const calls = { calcom: 0, slate: 0 };
  const d: Parameters<typeof runPilotOfferSample>[0] = {
    nowMs: NOW,
    bucketCode: "112",
    calcomTimeZone: "America/New_York",
    lastSampledAtMs: async () => null,
    readCalcom: async () => {
      calls.calcom++;
      return { status: 200, data: { eventTypeId: 1314152, slots: { d: [{ start: at(25) }, { start: at(21) }] } } };
    },
    readSlate: async () => {
      calls.slate++;
      return [at(1), at(2), at(3)];
    },
    insert: async (rows) => {
      inserted.push(rows);
    },
    ...over,
  };
  return { d, inserted, calls };
}

{
  const { d, inserted } = deps();
  const out = await runPilotOfferSample(d);
  eq(out, { sampled: true, calcom: "ok", slate: "ok" }, "a due sample reads both systems");
  eq(inserted.length, 1, "and writes both rows in one insert");
  const [calcom, slate] = inserted[0]!;
  eq(calcom, {
    sampled_at: new Date(NOW).toISOString(),
    system: "calcom",
    bucket_code: "112",
    ok: true,
    earliest_offered_at: at(21),
    offered_24h: 1,
    error: null,
    calcom_time_zone: "America/New_York",
  }, "the cal.com row carries its earliest time, its count, and the zone it was asked in");
  eq(slate.calcom_time_zone, null, "the Slate row carries no cal.com zone");
  eq(slate.system, "slate", "the Slate row is the second");
  eq([slate.earliest_offered_at, slate.offered_24h], [at(1), 3], "and carries Slate's");
}
{
  const { d, inserted, calls } = deps({ lastSampledAtMs: async () => NOW - 5 * 60_000 });
  const out = await runPilotOfferSample(d);
  eq(out, { sampled: false }, "a sample taken five minutes ago means none now");
  eq([calls.calcom, calls.slate, inserted.length], [0, 0, 0], "and neither system is asked");
}
{
  const { d, inserted } = deps({
    readCalcom: async () => {
      throw new Error("fetch failed");
    },
  });
  const out = await runPilotOfferSample(d);
  eq(out, { sampled: true, calcom: "failed", slate: "ok" }, "a cal.com outage does not stop Slate's reading");
  const calcom = inserted[0]![0]!;
  eq([calcom.ok, calcom.offered_24h, calcom.earliest_offered_at], [false, null, null], "the failure is stored as unknown, never as zero times");
  eq(calcom.error, "fetch failed", "with the reason");
  eq(calcom.calcom_time_zone, "America/New_York", "a failed cal.com read still records the zone it asked in");
}
{
  const { d, inserted } = deps({ readCalcom: async () => ({ status: 500, data: undefined }) });
  await runPilotOfferSample(d);
  eq(inserted[0]![0]!.error, "cal.com answered 500", "a refused cal.com call stores its status as the reason");
}
{
  const { d, inserted } = deps({
    readSlate: async () => {
      throw new Error("bucket 112 not found");
    },
  });
  const out = await runPilotOfferSample(d);
  eq(out, { sampled: true, calcom: "ok", slate: "failed" }, "a Slate read failure is recorded the same way");
  eq([inserted[0]![1]!.ok, inserted[0]![1]!.offered_24h], [false, null], "as unknown, never as zero");
}
{
  const { d } = deps({
    insert: async () => {
      throw new Error("insert refused");
    },
  });
  let threw = false;
  try {
    await runPilotOfferSample(d);
  } catch {
    threw = true;
  }
  assert(threw, "a sample that could not be stored throws, so the lane's step failure streak can page");
}

// --- the report's summary --------------------------------------------------------
const row = (system: "slate" | "calcom", minutes: number | null, count: number | null, sampleAt: string): PilotOfferRow => ({
  sampled_at: sampleAt,
  system,
  bucket_code: "112",
  ok: minutes !== null || count !== null,
  earliest_offered_at: minutes === null ? null : new Date(Date.parse(sampleAt) + minutes * 60_000).toISOString(),
  offered_24h: count,
  error: minutes === null && count === null ? "cal.com answered 500" : null,
  calcom_time_zone: system === "calcom" ? PILOT_OFFER_TIME_ZONE : null,
});
{
  const t1 = at(0);
  const t2 = at(0, 15);
  const t3 = at(0, 30);
  const s = summarisePilotOffers([
    row("slate", 120, 200, t1),
    row("calcom", 1200, 30, t1),
    row("slate", 150, 210, t2),
    row("calcom", 60, 40, t2),
    row("slate", 90, 190, t3),
    row("calcom", null, null, t3),
  ]);
  eq(s.slate, { samples: 3, failed: 0, nothingIn24h: 0, medianMinutesToFirst: 120, medianOffered24h: 200 }, "Slate's typical wait and count, from its readable samples");
  eq(s.calcom, { samples: 3, failed: 1, nothingIn24h: 0, medianMinutesToFirst: 630, medianOffered24h: 35 }, "cal.com's, with the failed sample counted and left out of the medians");
  eq(s.paired, 2, "only quarter hours where BOTH systems were read are compared");
  eq([s.slateEarlier, s.calcomEarlier, s.same], [1, 1, 0], "and each system offered the earlier time in one of those two");
}
{
  const s = summarisePilotOffers([]);
  eq([s.slate.samples, s.calcom.samples, s.paired], [0, 0, 0], "no samples is no samples");
  eq(s.slate.medianMinutesToFirst, null, "with no median rather than a zero");
}
{
  // A system that answered with nothing must not be scored as a zero minute wait (it
  // offered NOTHING, the opposite of immediately), nor dropped from the median, which
  // would describe only the samples where it did offer something (#3328).
  const t = at(0);
  const s = summarisePilotOffers([
    { ...row("slate", 60, 10, t) },
    { sampled_at: t, system: "calcom", bucket_code: "112", ok: true, earliest_offered_at: null, offered_24h: 0, error: null, calcom_time_zone: "America/New_York" },
  ]);
  eq(s.calcom.medianOffered24h, 0, "an empty answer counts as zero times");
  eq(s.calcom.medianMinutesToFirst, "nothing", "and its median is nothing in the next 24 hours, never a wait");
  eq(s.calcom.nothingIn24h, 1, "and it is counted as a sample with nothing in the next 24 hours");
  eq([s.paired, s.slateEarlier, s.calcomEarlier, s.same], [1, 1, 0, 0], "a system offering something is earlier than one offering nothing");
}

// --- #3328: both systems judged over the same next 24 hours ------------------------
// cal.com's routed answer reaches only so far, so where it had nothing in the next
// day it stored NO first time, while Slate, which answers out to its horizon, stored
// one a day and a half away. The old summary dropped cal.com's empty samples from its
// median and kept Slate's distant ones, so the report set Slate's 33 hours against
// cal.com's 5 over two different sets of quarter hours. Both are now judged over the
// next 24 hours: a first time beyond them, or none at all, is nothing in the next 24
// hours for either system alike.
const none = (system: "slate" | "calcom", sampleAt: string): PilotOfferRow => ({
  ...row(system, 0, 0, sampleAt),
  earliest_offered_at: null,
});
{
  // Slate's first time beyond 24 hours while cal.com had nothing: the same answer.
  const t = at(0);
  const s = summarisePilotOffers([row("slate", 33 * 60, 0, t), none("calcom", t)]);
  eq(s.slate.medianMinutesToFirst, "nothing", "a first time 33 hours away is nothing in the next 24 hours, never a 33 hour wait");
  eq([s.slate.nothingIn24h, s.calcom.nothingIn24h], [1, 1], "and both systems count it as nothing in the next 24 hours");
  eq([s.paired, s.slateEarlier, s.calcomEarlier, s.same], [1, 0, 0, 1], "so neither is credited with the earlier time");
  const lines = pilotOffersReportLines({ ok: true, summary: s });
  eq(lines.slice(1), [
    "  Slate: typically 0 times in the next 24 hours, first one: nothing in the next 24 hours, over 1 readable sample, 1 of which had nothing in the next 24 hours",
    "  cal.com: typically 0 times in the next 24 hours, first one: nothing in the next 24 hours, over 1 readable sample, 1 of which had nothing in the next 24 hours",
    "  Of 1 quarter hour where both were read, Slate offered the earlier first time in 0, cal.com in 0, and neither in 1 (the same first time, or nothing from either in the next 24 hours).",
  ], "the report says nothing in the next 24 hours for both, rather than a 33 hour wait against none");
}
{
  // Positive control on the window's edge, the same edge the sampler's count uses: a
  // first time a minute inside the day is a wait, one exactly a day away is not.
  const inside = summarisePilotOffers([row("slate", 24 * 60 - 1, 1, at(0)), none("calcom", at(0))]);
  eq(inside.slate.medianMinutesToFirst, 24 * 60 - 1, "a first time a minute inside the next 24 hours is a wait");
  eq([inside.slateEarlier, inside.same], [1, 0], "and is earlier than nothing");
  const edge = summarisePilotOffers([row("slate", 24 * 60, 0, at(0)), none("calcom", at(0))]);
  eq(edge.slate.medianMinutesToFirst, "nothing", "one exactly 24 hours away is outside them, as the sampler's count has it");
  eq([edge.slateEarlier, edge.same], [0, 1], "and ties with nothing");
}
{
  // One or both systems offering nothing, across three quarter hours: one each way
  // and one where neither had anything.
  const [t1, t2, t3] = [at(0), at(0, 15), at(0, 30)];
  const s = summarisePilotOffers([
    none("slate", t1),
    row("calcom", 60, 4, t1),
    none("slate", t2),
    none("calcom", t2),
    row("slate", 30, 9, t3),
    none("calcom", t3),
  ]);
  eq([s.slate.nothingIn24h, s.calcom.nothingIn24h], [2, 2], "each system's samples with nothing in the next 24 hours are counted");
  eq([s.paired, s.slateEarlier, s.calcomEarlier, s.same], [3, 1, 1, 1], "Slate earlier once, cal.com earlier once, and the same once when neither had anything");
  eq(s.slateEarlier + s.calcomEarlier + s.same, s.paired, "every paired quarter hour lands in exactly one of the three");
  const lines = pilotOffersReportLines({ ok: true, summary: s });
  eq(lines.slice(1), [
    "  Slate: typically 0 times in the next 24 hours, first one: nothing in the next 24 hours, over 3 readable samples, 2 of which had nothing in the next 24 hours",
    "  cal.com: typically 0 times in the next 24 hours, first one: nothing in the next 24 hours, over 3 readable samples, 2 of which had nothing in the next 24 hours",
    "  Of 3 quarter hours where both were read, Slate offered the earlier first time in 1, cal.com in 1, and neither in 1 (the same first time, or nothing from either in the next 24 hours).",
  ], "the lines carry each system's count and all three pairing counts");
}
{
  // The same first instant from both is a tie, not a win for either.
  const t = at(0);
  const s = summarisePilotOffers([row("slate", 90, 5, t), row("calcom", 90, 3, t)]);
  eq([s.slateEarlier, s.calcomEarlier, s.same], [0, 0, 1], "the same first time is counted as the same");
}
{
  // The median ranks nothing in the next 24 hours slowest rather than dropping it.
  const [t1, t2, t3] = [at(0), at(0, 15), at(0, 30)];
  const ranked = summarisePilotOffers([row("calcom", 60, 5, t1), row("calcom", 120, 3, t2), none("calcom", t3)]);
  eq(ranked.calcom.medianMinutesToFirst, 120, "with one of three empty, the median is the slower of the two waits, not their midpoint");
  const lines = pilotOffersReportLines({ ok: true, summary: ranked });
  eq(
    lines.find((l) => l.startsWith("  cal.com:")),
    "  cal.com: typically 3 times in the next 24 hours, first one in 2h 0m, over 3 readable samples, 1 of which had nothing in the next 24 hours",
    "and the line gives that wait with the count of empty samples beside it",
  );

  const lands = summarisePilotOffers([row("calcom", 60, 5, t1), none("calcom", t2), row("calcom", 30 * 60, 0, t3)]);
  eq(lands.calcom.medianMinutesToFirst, "nothing", "with two of three having nothing in the next 24 hours, the median lands on nothing");
  eq(lands.calcom.nothingIn24h, 2, "a first time beyond the day and no time at all are both counted");

  const half = summarisePilotOffers([row("calcom", 60, 5, t1), none("calcom", t2)]);
  eq(half.calcom.medianMinutesToFirst, "nothing", "with exactly half empty, the median is nothing, so no wait is claimed that half the samples lacked");
}
{
  // A system whose every sample failed has nothing to typify: the line must not read
  // as a measured zero.
  const t = at(0);
  const s = summarisePilotOffers([row("slate", 60, 10, t), row("calcom", null, null, t)]);
  eq(s.calcom, { samples: 1, failed: 1, nothingIn24h: 0, medianMinutesToFirst: null, medianOffered24h: null }, "a system with no readable sample has no medians");
  const line = pilotOffersReportLines({ ok: true, summary: s }).find((l) => l.startsWith("  cal.com:"));
  eq(line, "  cal.com: no readable samples (1 of 1 cal.com samples failed and are left out)", "and its line says so rather than typically 0 times");
}


// --- the report's lines --------------------------------------------------------
{
  const lines = pilotOffersReportLines({ ok: true, summary: summarisePilotOffers([]) });
  assert(lines.some((l) => l.includes("no availability samples")), "no samples says so, rather than reading as equal availability");
}
{
  const lines = pilotOffersReportLines({ ok: false, message: "relation does not exist" });
  assert(lines.some((l) => l.includes("could not be read") && l.includes("relation does not exist")), "an unreadable table says so, with the reason");
}
{
  const lines = pilotOffersReportLines({ ok: "skipped", missing: ["SUPABASE_SECRET_KEY"] });
  assert(lines.some((l) => l.includes("skipped") && l.includes("SUPABASE_SECRET_KEY")), "a skipped read names what was missing");
}
{
  const t = at(0);
  const summary = summarisePilotOffers([row("slate", 90, 200, t), row("calcom", 1200, 30, t), row("calcom", null, null, at(0, 15))]);
  const text = pilotOffersReportLines({ ok: true, summary }).join("\n");
  assert(text.includes("Slate") && text.includes("200"), "Slate's typical count is shown");
  assert(text.includes("cal.com") && text.includes("30"), "and cal.com's");
  assert(text.includes("1 of 2 cal.com samples failed") || text.includes("1 failed"), "failed samples are counted out loud");
  assert(
    text.includes("Of 1 quarter hour where both were read, Slate offered the earlier first time in 1, cal.com in 0, and neither in 0"),
    "and how often each offered the earlier time, out of the quarter hours both were read",
  );
}

// --- a stored stamp that cannot be read -------------------------------------------
{
  // Neither a wait nor nothing can be read off it, so it is left out with the failed
  // reads rather than guessed into either answer.
  const t = at(0);
  const s = summarisePilotOffers([
    { ...row("slate", 60, 10, t), earliest_offered_at: "not a time" },
    row("calcom", 1200, 30, t),
  ]);
  eq(s.slate.medianMinutesToFirst, null, "an unreadable stored time gives no wait, rather than a NaN one");
  eq([s.slate.failed, s.slate.nothingIn24h], [1, 0], "and is counted with the samples left out, never as nothing offered");
  eq([s.paired, s.slateEarlier, s.calcomEarlier], [0, 0, 0], "and never credits either system with the earlier time");
}

// --- #3002: samples taken before cal.com was asked in a time zone -------------------
// Without a timeZone cal.com answered a truncated list, so those cal.com rows read
// too low, and the Slate rows beside them would be compared against them. The whole
// quarter hour is left out, and the report says how many.
{
  const old = at(-1);
  const fixed = at(0);
  const s = summarisePilotOffers([
    row("slate", 60, 20, old),
    { ...row("calcom", 600, 3, old), calcom_time_zone: null },
    row("slate", 90, 23, fixed),
    row("calcom", 10, 42, fixed),
  ]);
  eq(s.leftOutTruncated, 1, "the quarter hour read without a zone is counted as left out");
  eq([s.slate.samples, s.calcom.samples], [1, 1], "and neither system's row from it is summarised");
  eq([s.calcom.medianOffered24h, s.slate.medianOffered24h], [42, 23], "so the medians come only from the fixed read");
  eq([s.paired, s.slateEarlier], [1, 0], "and it is not paired");
  const text = pilotOffersReportLines({ ok: true, summary: s }).join("\n");
  assert(text.includes("1 quarter hour") && text.includes("#3002"), "the report says how many were left out and why");
}
{
  const s = summarisePilotOffers([row("slate", 90, 23, at(0)), row("calcom", 10, 42, at(0))]);
  eq(s.leftOutTruncated, 0, "nothing is left out when every cal.com row carries a zone");
  assert(!pilotOffersReportLines({ ok: true, summary: s }).join("\n").includes("#3002"), "and the report says nothing about it");
}
{
  // Positive control: the same rows with the zone stripped must be left out, or the
  // test above passes on a summary that never looks at the column.
  const s = summarisePilotOffers([row("slate", 90, 23, at(0)), { ...row("calcom", 10, 42, at(0)), calcom_time_zone: null }]);
  eq([s.leftOutTruncated, s.calcom.samples], [1, 0], "a cal.com row with no zone is left out");
  const blank = summarisePilotOffers([row("slate", 90, 23, at(0)), { ...row("calcom", 10, 42, at(0)), calcom_time_zone: "" }]);
  eq(blank.leftOutTruncated, 1, "and so is one whose zone is empty, since it says nothing about what was asked");
}

// --- the report's read -------------------------------------------------------------
{
  let fetched = 0;
  const skipped = await readPilotOffersForReport({
    missing: ["SUPABASE_SECRET_KEY"],
    fetchRows: async () => {
      fetched++;
      return [];
    },
  });
  eq(skipped, { ok: "skipped", missing: ["SUPABASE_SECRET_KEY"] }, "missing credentials skip the read and name what is missing");
  eq(fetched, 0, "and nothing is fetched");
}
{
  const failed = await readPilotOffersForReport({
    missing: [],
    fetchRows: async () => {
      throw new Error("relation does not exist");
    },
  });
  eq(failed, { ok: false, message: "relation does not exist" }, "a failed read is reported with its reason, never as no samples");
}
{
  const t = at(0);
  const read = await readPilotOffersForReport({ missing: [], fetchRows: async () => [row("slate", 60, 10, t), row("calcom", 120, 5, t)] });
  assert(read.ok === true && read.summary.paired === 1, "a readable table is summarised");
}

finish();

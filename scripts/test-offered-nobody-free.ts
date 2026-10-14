// #3381 step 2: is the booker offering a time the confirm would refuse, for longer
// than a few minutes?
//
// On 2026-10-14 a stored row two minutes old offered 4:30 PM in bucket 112 while the
// confirm's candidate read found none of its 74 advisors free, and on 2026-10-06 the
// booker offered 112 times that had been full for hours. Nothing checked a SERVED time
// against the confirm's own judgment. These drive the check end to end with an
// in-memory marker store, a scripted judge and an injected clock: the second look that
// decides a page, every way the all clear must stay silent, and the copy.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-offered-nobody-free.ts
import {
  formatOfferedNobodyFreeAlert,
  formatOfferedNobodyFreeAllClear,
  LEAD_MS,
  MAX_JUDGMENTS_PER_TICK,
  newSamples,
  OFFERED_CHECK_CADENCE_MS,
  OFFERED_NOBODY_FREE_ALERT_KEY,
  PERSIST_MS,
  runOfferedNobodyFreeCheck,
  servedStarts,
  suspectId,
  writerName,
  type Judgment,
  type OfferedNobodyFreeDeps,
  type OfferedRow,
  type Suspect,
} from "../src/lib/monitor/offered-nobody-free.ts";
import { RECOMPUTE_FRESH_MS } from "../src/lib/availability/precompute-cron.ts";
import { MONITOR_CADENCE_MS } from "../src/lib/monitor/step-failure.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// 2026-10-14 08:46 UTC is 4:46 AM ET, the refusal's own minute.
const NOW = Date.parse("2026-10-14T08:46:00.000Z");
const T1630 = Date.parse("2026-10-14T20:30:00.000Z"); // 4:30 PM ET
const T1610 = Date.parse("2026-10-14T20:10:00.000Z"); // 4:10 PM ET
const T1000 = Date.parse("2026-10-14T14:00:00.000Z"); // 10:00 AM ET
const iso = (ms: number) => new Date(ms).toISOString();

const OPEN_ALL_WEEK = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
  exceptions: [],
};

const row = (code: string, slots: number[], extra: Record<string, unknown> = {}): OfferedRow => ({
  bucket_code: code,
  computed_at: "2026-10-14T08:44:39.000Z",
  payload: {
    bucket: { code },
    eventType: { duration_min: 20, buffer_before_min: 10, buffer_after_min: 10, min_notice_min: 120 },
    orgName: "Pennie",
    slots: slots.map(iso),
    writtenBy: "lane",
    ...extra,
  },
});

interface World {
  deps: OfferedNobodyFreeDeps;
  markers: Map<string, Suspect>;
  sent: { key: string; text: string }[];
  resolved: { key: string; text: string }[];
  judged: string[];
  logs: Record<string, unknown>[];
}

function world(over: {
  nowMs?: number;
  rows?: OfferedRow[];
  pools?: string[][] | Error;
  suspects?: Suspect[] | Error;
  judge?: (code: string, startMs: number) => Judgment | null | Error;
}): World {
  const markers = new Map<string, Suspect>();
  for (const s of Array.isArray(over.suspects) ? over.suspects : []) markers.set(suspectId(s.code, s.startMs), s);
  const w: World = { markers, sent: [], resolved: [], judged: [], logs: [], deps: null as never };
  w.deps = {
    nowMs: over.nowMs ?? NOW,
    rows: over.rows ?? [row("112", [T1000, T1610, T1630])],
    hours: OPEN_ALL_WEEK,
    loadPools: async () => {
      if (over.pools instanceof Error) throw over.pools;
      return over.pools ?? [["111", "112"]];
    },
    readSuspects: async () => {
      if (over.suspects instanceof Error) throw over.suspects;
      return [...markers.values()];
    },
    judge: async (code, startMs) => {
      w.judged.push(suspectId(code, startMs));
      const r = over.judge ? over.judge(code, startMs) : { free: 3, members: 74 };
      if (r instanceof Error) throw r;
      return r;
    },
    markSuspect: async (code, startMs, firstSeenMs) => {
      markers.set(suspectId(code, startMs), { code, startMs, firstSeenMs });
    },
    clearSuspect: async (code, startMs) => {
      markers.delete(suspectId(code, startMs));
    },
    notify: async (key, _cooldown, text) => {
      w.sent.push({ key, text });
    },
    resolve: async (key, text) => {
      w.resolved.push({ key, text });
      return true;
    },
    cooldownMs: 60 * 60_000,
    log: (fields) => {
      w.logs.push(fields);
    },
  };
  return w;
}

// --- the numbers are derived, not restated ------------------------------------------
eq(PERSIST_MS, RECOMPUTE_FRESH_MS, "a time pages only once the recompute lane has had a whole freshness window to drop it");
eq(OFFERED_CHECK_CADENCE_MS, MONITOR_CADENCE_MS, "the check's cadence is the monitor lane's");
assert(OFFERED_CHECK_CADENCE_MS >= PERSIST_MS, "so the very next tick's look is already past the persistence window");

// --- what a code is serving ---------------------------------------------------------
{
  const served = servedStarts(
    [
      row("112", [T1630, NOW + 10 * 60_000, NOW + 90 * 60_000, T1000]),
      { bucket_code: "999", computed_at: "x", payload: { nope: true } },
    ],
    OPEN_ALL_WEEK,
    NOW,
  );
  eq(served.get("112")!.starts, [T1000, T1630], "sorted, and nothing inside the lead or the event type's notice, which nobody is shown");
  eq(served.get("112")!.writtenBy, "lane", "with the row's writer");
  assert(!served.has("999"), "a malformed row serves nothing rather than throwing");
  const shut = servedStarts([row("112", [T1630])], { zone: "America/New_York", rules: [], exceptions: [] }, NOW);
  eq(shut.get("112")!.starts, [], "a time the org's week has shut is not served, so it is not judged");
  assert(LEAD_MS >= 15 * 60_000, "the lead keeps clear of a booking landing right now");
}

// --- a first sighting is remembered, never paged ------------------------------------
{
  const w = world({ judge: (_c, s) => (s === T1630 ? { free: 0, members: 74 } : { free: 2, members: 74 }), pools: [["112"]], rows: [row("112", [T1630])] });
  const r = await runOfferedNobodyFreeCheck(w.deps);
  assert(r.status === "measured" && r.nobodyFree === 1, "the time was judged offered with nobody free");
  eq(w.sent.length, 0, "a first sighting never pages: a calendar change a moment ago is still a lag");
  eq(w.resolved.length, 0, "and it is not an all clear either, with a time nobody is free for in hand");
  assert(w.markers.has(suspectId("112", T1630)), "it is remembered for a second look");
  eq(w.markers.get(suspectId("112", T1630))!.firstSeenMs, NOW, "stamped with when it was first seen");
  const line = w.logs.find((l) => l.msg === "offered time nobody is free for");
  assert(line !== undefined && line.written_by === "lane" && line.members === 74, "and logged with the row's writer and the pool size");
}

// --- the second look, past the window, still nobody free: page -----------------------
{
  const later = NOW + OFFERED_CHECK_CADENCE_MS;
  const w = world({
    nowMs: later,
    pools: [["112"]],
    rows: [row("112", [T1630])],
    suspects: [{ code: "112", startMs: T1630, firstSeenMs: NOW }],
    judge: () => ({ free: 0, members: 74 }),
  });
  const r = await runOfferedNobodyFreeCheck(w.deps);
  eq(w.judged[0], suspectId("112", T1630), "the remembered time is looked at first");
  assert(r.status === "measured" && r.persisting.length === 1, "it has persisted");
  eq(w.sent.length, 1, "and pages");
  eq(w.sent[0]!.key, OFFERED_NOBODY_FREE_ALERT_KEY, "on the one condition key");
  assert(w.sent[0]!.text.includes("112 at 4:30pm ET on Wednesday, October 14"), "naming the bucket and the time in Eastern");
  eq(w.resolved.length, 0, "and clears nothing");
  assert(w.markers.has(suspectId("112", T1630)), "the marker stays while it is true, keeping the first sighting");
}

// --- the second look, before the window: not yet ------------------------------------
{
  const w = world({
    nowMs: NOW + PERSIST_MS - 1,
    pools: [["112"]],
    rows: [row("112", [T1630])],
    suspects: [{ code: "112", startMs: T1630, firstSeenMs: NOW }],
    judge: () => ({ free: 0, members: 74 }),
  });
  await runOfferedNobodyFreeCheck(w.deps);
  eq(w.sent.length, 0, "a second look inside the freshness window does not page yet");
}

// --- the second look finds somebody free: forgotten, and that is the all clear -------
{
  const w = world({
    nowMs: NOW + OFFERED_CHECK_CADENCE_MS,
    pools: [["112"]],
    rows: [row("112", [T1630])],
    suspects: [{ code: "112", startMs: T1630, firstSeenMs: NOW }],
    judge: () => ({ free: 1, members: 74 }),
  });
  const r = await runOfferedNobodyFreeCheck(w.deps);
  assert(!w.markers.has(suspectId("112", T1630)), "a remembered time found free is forgotten");
  assert(r.status === "measured" && r.cleared, "and with nothing left remembered, the condition is over");
  eq(w.resolved.length, 1, "so the all clear is sent, off a measured healthy look");
  eq(w.sent.length, 0, "with no page");
}

// --- a remembered time the row no longer offers is over without a judgment ----------
{
  const w = world({
    nowMs: NOW + OFFERED_CHECK_CADENCE_MS,
    pools: [["112"]],
    rows: [row("112", [T1000])],
    suspects: [{ code: "112", startMs: T1630, firstSeenMs: NOW }],
  });
  await runOfferedNobodyFreeCheck(w.deps);
  assert(!w.markers.has(suspectId("112", T1630)), "the row dropped it, so it is forgotten");
  assert(!w.judged.includes(suspectId("112", T1630)), "without spending a judgment on it");
}

// --- the all clear stays silent whenever the signal could not be read ----------------
{
  // The judge cannot answer: the remembered time is neither paged nor cleared.
  const w = world({
    nowMs: NOW + OFFERED_CHECK_CADENCE_MS,
    pools: [["112"]],
    rows: [row("112", [T1630])],
    suspects: [{ code: "112", startMs: T1630, firstSeenMs: NOW }],
    judge: () => null,
  });
  const r = await runOfferedNobodyFreeCheck(w.deps);
  assert(r.status === "measured" && r.unreadable === 1 && r.judged === 0, "an unanswered read is counted as unreadable, never as free");
  eq(w.sent.length + w.resolved.length, 0, "and neither pages nor clears");
  assert(w.markers.has(suspectId("112", T1630)), "the remembered time is kept for the next look");
}
{
  const w = world({
    nowMs: NOW + OFFERED_CHECK_CADENCE_MS,
    pools: [["112"]],
    rows: [row("112", [T1630])],
    suspects: [{ code: "112", startMs: T1630, firstSeenMs: NOW }],
    judge: () => new Error("ladder read refused"),
  });
  const r = await runOfferedNobodyFreeCheck(w.deps);
  assert(r.status === "measured" && r.unreadable === 1, "a judge that throws is unreadable too");
  eq(w.sent.length + w.resolved.length, 0, "and says nothing either way");
  const why = w.logs.find((l) => l.msg === "offered time could not be judged");
  assert(why !== undefined && String(why.why).includes("ladder read refused") && why.bucket === "112", "and the reason it threw is logged, with the bucket");
}
{
  const w = world({ pools: new Error("bucket_members read failed") });
  const r = await runOfferedNobodyFreeCheck(w.deps);
  eq(r.status, "unreadable", "no pools is not a quiet day");
  eq(w.sent.length + w.resolved.length + w.judged.length, 0, "it judges, pages and clears nothing");
}
{
  const w = world({ suspects: new Error("alert_state read failed") });
  const r = await runOfferedNobodyFreeCheck(w.deps);
  eq(r.status, "unreadable", "unreadable remembered times are not 'none remembered'");
  eq(w.sent.length + w.resolved.length + w.judged.length, 0, "so nothing is cleared off them");
}
{
  // Nothing served at all: nothing judged, so nothing measured and no all clear.
  const w = world({ rows: [row("112", [])], pools: [["112"]] });
  const r = await runOfferedNobodyFreeCheck(w.deps);
  assert(r.status === "measured" && r.judged === 0 && !r.cleared, "judging nothing is never an all clear");
}

// --- the budget: remembered times first, and an unexamined one holds the all clear ---
{
  const starts = Array.from({ length: MAX_JUDGMENTS_PER_TICK + 2 }, (_, i) => T1000 + i * 20 * 60_000);
  const suspects = starts.map((startMs, i) => ({ code: "112", startMs, firstSeenMs: NOW - i }));
  const w = world({ nowMs: NOW + OFFERED_CHECK_CADENCE_MS, pools: [["112"]], rows: [row("112", starts)], suspects, judge: () => ({ free: 1, members: 74 }) });
  const r = await runOfferedNobodyFreeCheck(w.deps);
  eq(w.judged.length, MAX_JUDGMENTS_PER_TICK, "never more judgments than the per tick ceiling");
  assert(r.status === "measured" && r.suspects === 2 && !r.cleared, "two remembered times left unexamined keep the condition open");
  eq(w.resolved.length, 0, "so no all clear yet");
}
{
  // Markers for times no longer offered are pruned before anything is judged.
  const stale = Array.from({ length: 10 }, (_, i) => ({ code: "999", startMs: T1000 + i * 60_000, firstSeenMs: NOW }));
  const w = world({ pools: [["112"]], rows: [row("112", [T1630])], judge: () => ({ free: 0, members: 74 }) });
  for (const s of stale) w.markers.set(suspectId(s.code, s.startMs), s);
  await runOfferedNobodyFreeCheck(w.deps);
  assert(w.markers.has(suspectId("112", T1630)) && w.markers.size === 1, "markers for times no longer offered are pruned");
}
{
  // The store is bounded by construction: every pool offering many times nobody is free
  // for, an hour of ticks, and the live markers never pass the judgment budget.
  const starts = Array.from({ length: 40 }, (_, i) => T1000 + i * 10 * 60_000);
  const pools = [["112"], ["211"], ["311"], ["411"]];
  const rows = pools.map(([c]) => row(c!, starts));
  const markers = new Map<string, Suspect>();
  let worst = 0;
  for (let k = 0; k < 12; k++) {
    const w = world({ nowMs: NOW + k * OFFERED_CHECK_CADENCE_MS, pools, rows, suspects: [...markers.values()], judge: () => ({ free: 0, members: 74 }) });
    await runOfferedNobodyFreeCheck(w.deps);
    markers.clear();
    for (const [id, s] of w.markers) markers.set(id, s);
    worst = Math.max(worst, markers.size);
  }
  assert(worst <= MAX_JUDGMENTS_PER_TICK, `the live markers never pass the judgment budget (worst ${worst})`);
}

// --- an empty pool serving a time is the same finding --------------------------------
{
  const w = world({
    nowMs: NOW + OFFERED_CHECK_CADENCE_MS,
    pools: [["112"]],
    rows: [row("112", [T1630])],
    suspects: [{ code: "112", startMs: T1630, firstSeenMs: NOW }],
    judge: () => ({ free: 0, members: 0 }),
  });
  await runOfferedNobodyFreeCheck(w.deps);
  assert(w.sent[0]?.text.includes("nobody is in its pool") === true, "a pool with nobody in it is said as such");
}

// --- the rotation reaches every pool, code and time ----------------------------------
{
  const pools = [["111", "112"], ["211"], ["311"]];
  const served = servedStarts([row("111", [T1000]), row("112", [T1610, T1630]), row("211", [T1000]), row("311", [T1630])], OPEN_ALL_WEEK, NOW);
  const seen = new Set<string>();
  for (let tick = 0; tick < 60; tick++) {
    const picked = newSamples(pools, served, tick, 1, new Set());
    eq(picked.length, 1, `tick ${tick} takes one sample at a budget of one`);
    seen.add(suspectId(picked[0]!.code, picked[0]!.startMs));
  }
  for (const id of [suspectId("111", T1000), suspectId("112", T1610), suspectId("112", T1630), suspectId("211", T1000), suspectId("311", T1630)]) {
    assert(seen.has(id), `the rotation reaches ${id}`);
  }
  // Fifteen pools (the production count) and a budget squeezed to one by remembered
  // times for every tick: a fixed stride sharing a factor with fifteen would keep
  // landing on the same few pools, and the mix must still reach every one.
  const fifteen = Array.from({ length: 15 }, (_, i) => [String(100 + i)]);
  const servedFifteen = servedStarts(fifteen.map(([c]) => row(c!, [T1630])), OPEN_ALL_WEEK, NOW);
  const reached = new Set<string>();
  for (let tick = 0; tick < 200; tick++) {
    for (const s of newSamples(fifteen, servedFifteen, tick, 1, new Set())) reached.add(s.code);
  }
  eq(reached.size, 15, "a budget of one still reaches all fifteen pools");
  const one = new Map([["112", { ...served.get("112")!, starts: [T1630] }]]);
  const twice = newSamples([["112"], ["112"]], one, 0, 2, new Set());
  eq(twice.length, 1, "and never judges one time twice in a tick");

  // The rotation's position comes from the tick alone, never from how much budget the
  // remembered times left: a tick with three remembered times takes the FIRST three of
  // the samples a tick with none would have taken, so the walk neither skips nor
  // repeats as remembered times come and go.
  const many = [["101"], ["102"], ["103"], ["104"], ["105"], ["106"], ["107"], ["108"]];
  const all = servedStarts(many.map(([c]) => row(c!, [T1000, T1630])), OPEN_ALL_WEEK, NOW);
  for (const tick of [0, 1, 5]) {
    const full = newSamples(many, all, tick, MAX_JUDGMENTS_PER_TICK, new Set());
    const part = newSamples(many, all, tick, 3, new Set());
    eq(part, full.slice(0, 3), `tick ${tick}: a smaller budget takes a prefix of the same rotation`);
  }
}

// --- the copy ------------------------------------------------------------------------
{
  const one = formatOfferedNobodyFreeAlert(
    [{ code: "112", startMs: T1630, firstSeenMs: NOW, members: 74, rowComputedAt: iso(NOW - 2 * 60_000), writtenBy: "lane" }],
    NOW + 5 * 60_000,
  );
  assert(one.startsWith("A stored row is offering a time nobody in its pool is free for"), "singular subject");
  assert(one.includes("a lead choosing it is refused unless a lower tier can take it"), "and it claims only what the pool's own read measured");
  assert(one.includes("for at least 5 min while none of its 74 advisors is free then"), "how long, and the pool");
  assert(one.includes("computed 7 min ago by the recompute lane"), "and the row's age and writer, in words");
  const many = formatOfferedNobodyFreeAlert(
    Array.from({ length: 7 }, (_, i) => ({ code: String(110 + i), startMs: T1630, firstSeenMs: NOW, members: 3, rowComputedAt: "x", writtenBy: null })),
    NOW + 5 * 60_000,
  );
  assert(many.startsWith("Stored rows are offering 7 times nobody in their pool is free for"), "plural subject");
  assert(many.includes("And 2 more."), "a truncated list says so");
  assert(many.includes("at an unknown time by an unrecorded path"), "an unreadable stamp and an unrecorded writer are said, never guessed");
  eq(writerName("booking+push+refusal"), "a booking's refresh and a Google push refresh and a refused confirm's refresh", "a shared refresh names every writer");
  eq(writerName("sweep:reconcile"), "the reconcile sweep", "a sweep by its label");
  assert(formatOfferedNobodyFreeAllClear(1).includes("1 offered time was judged"), "all clear, singular");
  assert(formatOfferedNobodyFreeAllClear(4).includes("4 offered times were judged"), "all clear, plural");
}

finish();

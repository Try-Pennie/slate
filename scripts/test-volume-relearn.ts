// #2739 and #2874: relearning the low volume floors from Slate's own bookings, per
// debt tier, refit on the monitor lane once a day.
// Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-volume-relearn.ts
//
// What this pins, each with a control (L159):
// - WHICH TIERS ARE CARRIED IS DERIVED. A tier with no real booking is not carried:
//   nothing is learned for it, and a tier nobody measured is UNJUDGED, never quiet.
// - EACH TIER HAS ITS OWN RAMP START, its first real booking, which a declared ramp
//   end can only move later. Nobody has to declare anything for a tier to be learned.
// - ONE TIER CANNOT MOVE ANOTHER. Widening the pilot to a second tier changes no
//   floor of the first: the property #2874 exists for.
// - A FAILED READ OR WRITE LEAVES THE FLOORS IN FORCE. The step throws, nothing is
//   written, and the baseline in force is unchanged (L105, L215).
// - THE CAL.COM FIT IS THE FLOOR UNDER A MEASURED TIER'S LEARNED FLOOR, at read time
//   as well as at fit time. An unmeasured tier has nothing under it, and says so.
// - A result belongs to the declared ramp end it was fitted under; changing that
//   takes it out of force and makes a refit due at once.
import { DateTime } from "luxon";
import {
  REFIT_EVERY_MS,
  REFIT_OVERDUE_MS,
  baselineInForce,
  parseRampEndForm,
  earliestRampEndLabel,
  EARLIEST_RAMP_END,
  rampEndMs,
  readStoredLearning,
  runVolumeRelearn,
  type StoredVolumeLearning,
} from "../src/lib/monitor/volume-relearn.ts";
import { learningStatusCopy, tierLearningLines } from "../src/lib/monitor/volume-relearn-copy.ts";
import { LEARNING, type SlateBookingRow } from "../src/lib/monitor/volume-learning.ts";
import { floorsFor, type FloorCell, type VolumeBaseline } from "../src/lib/monitor/volume-floors.ts";
import { MEASURED_VOLUME_BASELINE } from "../src/lib/monitor/volume-baseline.ts";
import { VOLUME_TIERS, type VolumeTier } from "../src/lib/monitor/volume-tiers.ts";
import { resolveFloors, resolveTierBaselines } from "../src/lib/monitor/settings.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const WEEK = 7 * DAY;

function anchor(floor30: number, floor120: number): VolumeBaseline {
  return {
    ...MEASURED_VOLUME_BASELINE,
    cells: Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, (): FloorCell => ({ floor30, floor120, typical120: floor120 * 3 })),
    ),
  };
}

const RAMP_END_ON = "2026-11-02"; // a Monday
const RAMP_END = DateTime.fromISO(`${RAMP_END_ON}T00:00`, { zone: ZONE }).toMillis();
const NOW = RAMP_END + 8 * WEEK + 3 * 60 * MIN;
// Low's first real booking: the moment the Low pages began sending leads.
const LOW_FIRST = RAMP_END + 9 * 60 * MIN;
// Medium's, when the pilot widened five weeks later.
const MEDIUM_FIRST = RAMP_END + 3 * WEEK + 9 * 60 * MIN;

function bookings(from: number, to: number, everyMin: number, tier: VolumeTier | null = "1", isTest = false): SlateBookingRow[] {
  const out: SlateBookingRow[] = [];
  for (let t = from; t < to; t += everyMin * MIN) out.push({ createdAtMs: t, isTest, tier });
  return out;
}

const noTier = (): Record<VolumeTier, number | null> => Object.fromEntries(VOLUME_TIERS.map((t) => [t, null]));

/** A relearn harness with every seam recorded. */
function harness(opts: {
  rampEndOn?: string | null;
  learning?: unknown;
  rows?: SlateBookingRow[];
  first?: Partial<Record<VolumeTier, number | null>>;
  readThrows?: boolean;
  firstThrows?: boolean;
  saveThrows?: boolean;
  configThrows?: boolean;
  anchors?: Partial<Record<VolumeTier, VolumeBaseline>>;
  nowMs?: number;
  closedDates?: string[];
  closedThrows?: boolean;
}) {
  const reads: { sinceIso: string; untilIso: string }[] = [];
  const firstReads: string[] = [];
  const closedReads: string[] = [];
  const saves: StoredVolumeLearning[] = [];
  const run = () =>
    runVolumeRelearn({
      nowMs: opts.nowMs ?? NOW,
      anchors: opts.anchors ?? { "1": anchor(0, 4) },
      zone: ZONE,
      readConfig: async () => {
        if (opts.configThrows) throw new Error("config read failed");
        return { rampEndOn: opts.rampEndOn ?? null, learning: opts.learning ?? null };
      },
      readFirstBookings: async (sinceIso) => {
        firstReads.push(sinceIso);
        if (opts.firstThrows) throw new Error("first bookings read failed");
        return { ...noTier(), ...(opts.first ?? { "1": LOW_FIRST }) };
      },
      readBookings: async (sinceIso, untilIso) => {
        reads.push({ sinceIso, untilIso });
        if (opts.readThrows) throw new Error("bookings read failed");
        return opts.rows ?? [];
      },
      readClosedDates: async (fromIsoDate) => {
        closedReads.push(fromIsoDate);
        if (opts.closedThrows) throw new Error("exceptions read failed");
        return opts.closedDates ?? [];
      },
      save: async (state) => {
        if (opts.saveThrows) throw new Error("write refused");
        saves.push(state);
      },
    });
  return { run, reads, firstReads, saves, closedReads };
}

async function rejects(p: Promise<unknown>, message: RegExp): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (err) {
    return err instanceof Error && message.test(err.message);
  }
}

const low = bookings(LOW_FIRST, NOW, 5, "1");
const medium = bookings(MEDIUM_FIRST, NOW, 10, "2");

// --- a Slate carrying no real booking in any tier learns nothing, and says which ---
{
  const h = harness({ first: {}, rows: low });
  const out = await h.run();
  eq(out.status, "refit", "the refit still runs, because which tiers are carried is itself measured");
  eq(h.firstReads.length, 1, "it reads each tier's first booking");
  eq(
    h.firstReads[0],
    DateTime.fromISO(`${EARLIEST_RAMP_END}T00:00`, { zone: ZONE }).toUTC().toISO(),
    "from the measurement's own date, so no booking before the cal.com fit can start a tier",
  );
  eq(h.reads.length, 0, "and, with no tier carried, reads no bookings");
  eq(h.closedReads.length, 0, "nor the org's closed days");
  const saved = h.saves[0]!;
  for (const tier of VOLUME_TIERS) eq(saved.tiers[tier]?.firstBookingAt, null, `tier ${tier} is recorded as looked at and not carried`);
  const lowNow = baselineInForce({ rampEndOn: null, learning: saved }, "1");
  eq(lowNow.kind, "measured", "Low stays on the cal.com measurement");
  if (lowNow.kind === "measured") eq(lowNow.why, "not-carried", "and says it is not carried yet");
  const mediumNow = baselineInForce({ rampEndOn: null, learning: saved }, "2");
  eq(mediumNow.kind, "unjudged", "a tier nobody measured and nobody books is unjudged, never quiet");
  if (mediumNow.kind === "unjudged") eq(mediumNow.why, "not-carried", "for that reason");
}

// --- a tier's first real booking starts it, with nothing declared ---
let fitted: StoredVolumeLearning | null = null;
{
  const h = harness({ rows: [...low, ...bookings(LOW_FIRST, NOW, 60, null, true)] });
  const out = await h.run();
  eq(out.status, "refit", "a carried tier with nothing stored refits on this tick");
  eq(h.reads.length, 1, "with one bookings read");
  eq(
    h.reads[0]!.sinceIso,
    new Date(NOW - LEARNING.horizonWeeks * WEEK).toISOString(),
    "that starts a full horizon back, so bookings before a ramp start are counted as excluded rather than never seen",
  );
  eq(h.reads[0]!.untilIso, new Date(NOW).toISOString(), "and ends at the tick");
  fitted = h.saves[0]!;
  const lowFit = fitted.tiers["1"]!;
  eq(lowFit.firstBookingAt, new Date(LOW_FIRST).toISOString(), "the stored result names the tier's first booking");
  eq(lowFit.rampStartAt, new Date(LOW_FIRST).toISOString(), "which is its ramp start, with nothing declared");
  eq(lowFit.result?.status, "learned", "eight steady weeks are learned");
  // The test bucket rows carry no tier, and must still be counted as left out
  // rather than disappearing before any tier saw them.
  const testRows = bookings(LOW_FIRST, NOW, 60, null, true).length;
  if (lowFit.result?.status === "learned") eq(lowFit.result.excludedTest, testRows, "every test booking read is counted as left out");
  const said = learningStatusCopy(baselineInForce({ rampEndOn: null, learning: h.saves[0] }, "1"), NOW + MIN).detail.join(" ");
  assert(said.includes(`Left out of the fit: ${testRows.toLocaleString("en-US")} test bookings`), `and the page says how many (${said})`);
  eq(fitted.tiers["2"]?.firstBookingAt, null, "and a tier nobody booked is not carried");
  eq(baselineInForce({ rampEndOn: null, learning: fitted }, "1").kind, "learned", "Low's learned floors are in force");
  if (out.status === "refit") eq(out.tiers["1"], "learned", "and the step reports it");
}

// --- #2874: widening to a second tier changes nothing about the first ---
{
  const alone = harness({ rows: low });
  await alone.run();
  const widened = harness({ rows: [...low, ...medium], first: { "1": LOW_FIRST, "2": MEDIUM_FIRST } });
  await widened.run();
  const lowAlone = alone.saves[0]!.tiers["1"]!.result;
  const lowWidened = widened.saves[0]!.tiers["1"]!.result;
  assert(
    lowAlone?.status === "learned" &&
      lowWidened?.status === "learned" &&
      JSON.stringify(lowAlone.baseline.cells) === JSON.stringify(lowWidened.baseline.cells),
    "Low's learned floors are identical whether or not Medium's bookings arrived beside them",
  );
  const med = widened.saves[0]!.tiers["2"]!;
  eq(med.firstBookingAt, new Date(MEDIUM_FIRST).toISOString(), "Medium is carried from its own first booking");
  eq(med.result?.status, "learned", "and after five weeks of its own bookings it is learned");
  const mediumNow = baselineInForce({ rampEndOn: null, learning: widened.saves[0] }, "2");
  eq(mediumNow.kind, "learned", "so Medium's own floors are in force, with no code change and no refit by hand");
  if (mediumNow.kind === "learned" && med.result?.status === "learned") {
    assert(
      JSON.stringify(mediumNow.baseline.cells) === JSON.stringify(med.result.baseline.cells),
      "and with no anchor under them, they are exactly what its traffic learned",
    );
  }
  // Control: the same Medium traffic, not yet four weeks old, is unjudged.
  const early = MEDIUM_FIRST + 2 * WEEK;
  const soon = harness({ rows: [...low, ...medium].filter((b) => b.createdAtMs < early), first: { "1": LOW_FIRST, "2": MEDIUM_FIRST }, nowMs: early });
  await soon.run();
  const mediumSoon = baselineInForce({ rampEndOn: null, learning: soon.saves[0] }, "2");
  eq(mediumSoon.kind, "unjudged", "control: two weeks after its first booking Medium is not yet judged");
  if (mediumSoon.kind === "unjudged") eq(mediumSoon.why, "insufficient", "because it has too few weeks");
}

// --- a declared ramp end can only move a tier's start later ---
{
  const h = harness({ rampEndOn: RAMP_END_ON, rows: low, first: { "1": LOW_FIRST - 3 * WEEK } });
  await h.run();
  eq(h.saves[0]!.tiers["1"]!.rampStartAt, new Date(RAMP_END).toISOString(), "a declared end after the first booking is the start");
  eq(h.saves[0]!.declaredRampEndOn, RAMP_END_ON, "and the refit records which declaration it ran under");
  const later = harness({ rampEndOn: "2026-10-12", rows: low });
  await later.run();
  eq(later.saves[0]!.tiers["1"]!.rampStartAt, new Date(LOW_FIRST).toISOString(), "a declared end before the first booking changes nothing");
}

// --- the org's closed days are read for the horizon and left out (#2764) ---
{
  const closed = ["2026-12-21", "2026-12-22", "2026-12-23", "2026-12-24", "2026-12-25"];
  const shut = low.filter((b) => !closed.includes(DateTime.fromMillis(b.createdAtMs, { zone: ZONE }).toISODate() ?? ""));
  const h = harness({ rows: shut, closedDates: closed });
  await h.run();
  eq(
    h.closedReads,
    [DateTime.fromMillis(NOW - LEARNING.horizonWeeks * WEEK, { zone: ZONE }).toISODate()],
    "the closed days are read once, from the first day of the horizon the bookings are read over",
  );
  eq(h.saves[0]?.tiers["1"]?.result?.status, "learned", "and a shut week recorded closed is not learned as a decline");
  const unread = harness({ rows: shut, closedDates: [] });
  await unread.run();
  eq(unread.saves[0]?.tiers["1"]?.result?.status, "declining", "control: the same week with no closed days recorded reads as a decline");

  const broken = harness({ rows: low, closedThrows: true });
  assert(await rejects(broken.run(), /exceptions read failed/), "an unreadable exceptions list throws, rather than fitting holidays in");
  eq(broken.saves.length, 0, "and nothing is written, so the floors in force stay");
}

// --- not due again inside a day, due after one ---
{
  const h = harness({ learning: fitted, rows: low, nowMs: NOW + REFIT_EVERY_MS - MIN });
  eq((await h.run()).status, "not-due", "a result younger than a day is not refit");
  eq(h.reads.length + h.firstReads.length, 0, "and reads nothing");
  const later = harness({ learning: fitted, rows: low, nowMs: NOW + REFIT_EVERY_MS });
  eq((await later.run()).status, "refit", "a day later it is refit");
}

// --- changing the declared ramp end makes a refit due at once, and takes the old one out of force ---
{
  const h = harness({ rampEndOn: "2026-11-09", learning: fitted, rows: low, nowMs: NOW + MIN });
  eq((await h.run()).status, "refit", "a new ramp end refits at once rather than waiting out the day");
  const inForce = baselineInForce({ rampEndOn: "2026-11-09", learning: fitted }, "1");
  eq(inForce.kind, "measured", "a result fitted under another ramp end is not in force");
  if (inForce.kind === "measured") eq(inForce.why, "other-ramp-end", "and says why");
}

// --- a failed read leaves the floors in force and says so ---
{
  for (const [what, flag] of [
    ["bookings", { readThrows: true }],
    ["first bookings", { firstThrows: true }],
  ] as const) {
    const h = harness({ learning: fitted, nowMs: NOW + 2 * DAY, rows: low, ...flag });
    assert(await rejects(h.run(), new RegExp(`${what} read failed`)), `a failed ${what} read throws, so the lane's step boundary reports it`);
    eq(h.saves.length, 0, `and nothing is written after a failed ${what} read: the stored floors stay in force`);
  }
  eq(baselineInForce({ rampEndOn: null, learning: fitted }, "1").kind, "learned", "the baseline in force is still the learned one");
  const ok = harness({ learning: fitted, rows: low, nowMs: NOW + 2 * DAY });
  eq((await ok.run()).status, "refit", "control: the same tick with readable tables refits");
}
{
  const h = harness({ configThrows: true });
  assert(await rejects(h.run(), /config read failed/), "an unreadable ramp end throws rather than reading as none declared");
  eq(h.reads.length + h.firstReads.length, 0, "and reads nothing");
}
{
  const h = harness({ rows: low, saveThrows: true });
  assert(await rejects(h.run(), /write refused/), "a refused write throws rather than reporting a refit");
}
{
  // A first bookings answer missing a tier is a malformed read, not a tier nobody booked.
  const h = harness({ rows: low });
  const partial = runVolumeRelearn({
    nowMs: NOW,
    anchors: { "1": anchor(0, 4) },
    zone: ZONE,
    readConfig: async () => ({ rampEndOn: null, learning: null }),
    readFirstBookings: async () => ({ "1": LOW_FIRST }),
    readBookings: async () => low,
    readClosedDates: async () => [],
    save: async (s) => void h.saves.push(s),
  });
  assert(await rejects(partial, /tier 2/), "an answer that says nothing about a tier is refused by name");
  eq(h.saves.length, 0, "and writes nothing");
}
{
  // An EMPTY read is not a failure, and it must never become learned zero floors.
  const h = harness({ rows: [], anchors: { "1": anchor(1, 9) } });
  await h.run();
  const r = h.saves[0]!.tiers["1"]!.result;
  if (r && (r.status === "learned" || r.status === "declining")) {
    assert(
      r.baseline.cells.every((d) => d.every((c) => c.floor120 >= 9 && c.floor30 >= 1)),
      "an empty table learns nothing below the cal.com floors",
    );
  } else {
    assert(true, `an empty table is ${r?.status}, not a set of zero floors`);
  }
}

// --- the cal.com fit is the floor under a measured tier's learned floor, at read time ---
{
  const lowered = JSON.parse(JSON.stringify(fitted)) as StoredVolumeLearning;
  const r = lowered.tiers["1"]!.result!;
  if (r.status === "learned") r.baseline.cells = r.baseline.cells.map((d) => d.map((c) => ({ ...c, floor30: 0, floor120: 2 })));
  const inForce = baselineInForce({ rampEndOn: null, learning: lowered }, "1", { "1": anchor(1, 11) });
  eq(inForce.kind, "learned", "a stored learned result is in force");
  const tuesday2pm = DateTime.fromISO("2027-01-05T14:10", { zone: ZONE }).toMillis();
  if (inForce.kind === "learned") {
    const floors = floorsFor({ baseline: inForce.baseline, override30: null, override120: null }, tuesday2pm);
    eq(floors.floor120, 11, "a learned 2 hour floor below the cal.com floor is judged at the cal.com floor");
    eq(floors.floor30, 1, "and so is the 30 minute floor");
  }
  const aboveAnchor = baselineInForce({ rampEndOn: null, learning: fitted }, "1", { "1": anchor(0, 1) });
  if (aboveAnchor.kind === "learned") {
    const kept = floorsFor({ baseline: aboveAnchor.baseline, override30: null, override120: null }, tuesday2pm);
    assert(kept.floor120 > 1, "control: a learned floor above the cal.com floor is kept as learned");
  }
}

// --- through the SAME resolvers the monitor and the admin page use ---
{
  const set = resolveFloors({ floor_30: null, floor_120: null, volume_ramp_end_on: null, volume_learning: fitted }, {});
  eq(set.baseline.source, "slate", "Low's learned floors are what the resolver serves, with nothing declared");
  const none = resolveFloors({ floor_30: null, floor_120: null, volume_ramp_end_on: null, volume_learning: null }, {});
  eq(none.baseline.source, "calcom", "control: with nothing learned it serves the cal.com measurement");
  const overridden = resolveFloors({ floor_30: 3, floor_120: null, volume_ramp_end_on: null, volume_learning: fitted }, {});
  eq(overridden.override30?.value, 3, "an override still replaces the floor it names");

  const widened = harness({ rows: [...low, ...medium], first: { "1": LOW_FIRST, "2": MEDIUM_FIRST } });
  await widened.run();
  const tiers = resolveTierBaselines({ volume_ramp_end_on: null, volume_learning: widened.saves[0] });
  eq(Object.keys(tiers), ["2"], "the tiers judged beside Low are exactly the learned ones");
  eq(tiers["2"]?.source, "slate", "each with its own learned floors");
  eq(Object.keys(resolveTierBaselines({ volume_ramp_end_on: null, volume_learning: fitted })), [], "control: with only Low carried there are none");
}

// --- a stored value that is not a result reads as unreadable, never as floors ---
{
  for (const bad of [{ version: 9 }, { version: 2, fittedAt: NOW, tiers: {} }, { version: 2, declaredRampEndOn: null, fittedAt: "2026-11-01T00:00:00Z", tiers: { "1": { firstBookingAt: "x", rampStartAt: null, result: null } } }, "nonsense", 7]) {
    eq(readStoredLearning(bad).state, "unreadable", `a malformed stored result is unreadable (${JSON.stringify(bad).slice(0, 50)})`);
  }
  const missingCell = JSON.parse(JSON.stringify(fitted)) as StoredVolumeLearning;
  const r = missingCell.tiers["1"]!.result!;
  if (r.status === "learned") r.baseline.cells[3]!.pop();
  eq(readStoredLearning(missingCell).state, "unreadable", "a learned result missing one hour is unreadable, not a zero floor");
  eq(readStoredLearning(null).state, "none", "null is nothing stored");
  eq(readStoredLearning(fitted).state, "ok", "control: a real stored result reads");
  const inForce = baselineInForce({ rampEndOn: null, learning: "nonsense" }, "1");
  eq(inForce.kind, "measured", "an unreadable result leaves the cal.com measurement in force");
  if (inForce.kind === "measured") eq(inForce.why, "unreadable", "and says so");
  const h = harness({ learning: "nonsense", rows: low });
  eq((await h.run()).status, "refit", "and the next tick refits over it");
}

// --- a result stored before #2874 is still read, as Low's, under the ramp end it named ---
{
  const lowFit = fitted!.tiers["1"]!;
  const legacy = { version: 1, rampEndOn: RAMP_END_ON, fittedAt: fitted!.fittedAt, result: lowFit.result };
  const read = readStoredLearning(legacy);
  eq(read.state, "ok", "a version 1 result reads");
  if (read.state === "ok") {
    eq(read.value.declaredRampEndOn, RAMP_END_ON, "under the ramp end it was fitted for");
    eq(Object.keys(read.value.tiers), ["1"], "as the Low tier's, the only tier it ever described");
  }
  eq(baselineInForce({ rampEndOn: RAMP_END_ON, learning: legacy }, "1").kind, "learned", "and stays in force while that ramp end is");
  const other = baselineInForce({ rampEndOn: null, learning: legacy }, "1");
  eq(other.kind, "measured", "control: with the ramp end cleared it is out of force until the next refit");
  // It never knew the tier's first booking, so the page must not say it did.
  const said = learningStatusCopy(baselineInForce({ rampEndOn: RAMP_END_ON, learning: legacy }, "1"), NOW + MIN).detail.join(" ");
  assert(/ramp end declared for Nov 2, 2026, recorded before Slate tracked each tier's first booking/.test(said), `a converted result names the declared ramp end it came from (${said})`);
  assert(!/first real Low booking/.test(said), "and never presents that date as a first booking");
  if (read.state === "ok") eq(read.value.tiers["1"]?.firstBookingAt, null, "the converted record claims no first booking");
  const h = harness({ rampEndOn: RAMP_END_ON, learning: legacy, rows: low, nowMs: Date.parse(fitted!.fittedAt) + MIN });
  eq((await h.run()).status, "refit", "a version 1 result is refit at once, so the per tier result replaces it");
}

// --- the ramp end date ---
{
  eq(rampEndMs(RAMP_END_ON, ZONE), RAMP_END, "a ramp end is the start of that day in the baseline's zone");
  eq(rampEndMs("2026-13-40", ZONE), null, "an impossible date is null");
  eq(parseRampEndForm({ intent: "clear", rampEnd: "" }), { ok: true, rampEndOn: null }, "clearing needs no date");
  eq(parseRampEndForm({ intent: "set", rampEnd: "2026-10-12" }), { ok: true, rampEndOn: "2026-10-12" }, "a valid date sets");
  const blank = parseRampEndForm({ intent: "set", rampEnd: "  " });
  eq(blank.ok, false, "setting with no date is refused, never read as clearing");
  const early = parseRampEndForm({ intent: "set", rampEnd: "2026-09-01" });
  eq(early.ok, false, "a date before the cal.com measurement is refused");
  eq(EARLIEST_RAMP_END, MEASURED_VOLUME_BASELINE.measuredOn, "the earliest ramp end is the measurement's own date");
  eq(earliestRampEndLabel(), "Sep 25, 2026", "the cutoff reads as the measurement's own date");
  assert(!early.ok && early.error.includes(earliestRampEndLabel()), "the refusal names the cutoff it enforces");
  eq(parseRampEndForm({ intent: "set", rampEnd: "2026-02-30" }).ok, false, "an impossible date is refused");
  eq(parseRampEndForm({ intent: "", rampEnd: "2026-10-12" }).ok, false, "a press that names neither setting nor clearing is refused");
}

// --- the admin wording, one state at a time ---
{
  const at = (learning: unknown, rampEndOn: string | null, nowMs = NOW + MIN) =>
    learningStatusCopy(baselineInForce({ rampEndOn, learning }, "1"), nowMs);
  const none = at(null, null);
  assert(/cal\.com measurement from Sep 25, 2026/.test(none.inForce), `nothing stored names the cal.com measurement (${none.inForce})`);
  assert(/first refit/.test(none.detail.join(" ")), `and says when the first refit runs (${none.detail})`);
  const empty = harness({ first: {} });
  await empty.run();
  const notCarried = at(empty.saves[0], null);
  assert(/first real Low booking/.test(notCarried.detail.join(" ")), `a tier nobody has booked says what starts learning (${notCarried.detail})`);
  const learned = at(fitted, null);
  assert(/learned from Slate's own bookings/.test(learned.inForce), `a learned result names itself (${learned.inForce})`);
  assert(/last refit/.test(learned.inForce), "and when it was last refit");
  assert(/No floor is below the cal\.com measurement/.test(learned.detail.join(" ")), "and states the floor under the floor");
  assert(/first real Low booking on/.test(learned.detail.join(" ")), `and where its ramp started (${learned.detail})`);
  const overdue = at(fitted, null, NOW + REFIT_OVERDUE_MS + MIN);
  assert(/No refit has succeeded since/.test(overdue.detail.join(" ")), `an old refit says refits are failing (${overdue.detail})`);
  const fresh = at(fitted, null, NOW + REFIT_OVERDUE_MS - MIN);
  assert(!/No refit has succeeded since/.test(fresh.detail.join(" ")), "control: a recent refit does not");
  const unreadable = at("nonsense", null);
  assert(/could not be read/.test(unreadable.detail.join(" ")), "an unreadable stored result says so");

  // The other tiers, one line each, every one of them stating what is true of it.
  const widened = harness({ rows: [...low, ...medium], first: { "1": LOW_FIRST, "2": MEDIUM_FIRST, "3": NOW - WEEK } });
  await widened.run();
  const lines = tierLearningLines({ rampEndOn: null, learning: widened.saves[0] }, NOW + MIN);
  eq(lines.length, VOLUME_TIERS.length - 1, "one line for every tier beside Low");
  assert(/^Medium: judged against floors learned from its own bookings/.test(lines[0]!), `a learned tier says so (${lines[0]})`);
  assert(/^High: carried since .*, and not judged until 4 full weeks/.test(lines[1]!), `a young tier says when it will be judged (${lines[1]})`);
  assert(/^Very High: no real booking yet, so not carried and not judged\.$/.test(lines[2]!), `a tier nobody booked says so (${lines[2]})`);
  const unreadLines = tierLearningLines({ rampEndOn: null, learning: "nonsense" }, NOW);
  assert(unreadLines.every((l) => /could not be read/.test(l)), "an unreadable result says so for every tier rather than calling them not carried");
  for (const c of [none, notCarried, learned, overdue, unreadable]) {
    for (const line of [c.inForce, ...c.detail, ...lines, ...unreadLines]) {
      assert(!/undefined|NaN|null|\[object/.test(line), `no leaked value in "${line.slice(0, 50)}"`);
      assert(!/[\u2014\u2013]/.test(line), "no dashes in the copy");
    }
  }
}

finish();

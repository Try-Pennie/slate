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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import {
  ANCHOR_OVERLAP_WEEKS,
  REFIT_EVERY_MS,
  REFIT_OVERDUE_MS,
  baselineInForce,
  parseRampEndForm,
  earliestRampEndLabel,
  EARLIEST_RAMP_END,
  rampEndMs,
  readStoredLearning,
  runVolumeRelearn,
  shareInForce,
  type StoredVolumeLearning,
} from "../src/lib/monitor/volume-relearn.ts";
import { anchorRetirementSentence, learningStatusCopy, rampEndLowFloorNote, tierLearningLines } from "../src/lib/monitor/volume-relearn-copy.ts";
import { LEARNING, type SlateBookingRow } from "../src/lib/monitor/volume-learning.ts";
import { floorsFor, type FloorCell, type VolumeBaseline } from "../src/lib/monitor/volume-floors.ts";
import { MEASURED_VOLUME_BASELINE } from "../src/lib/monitor/volume-baseline.ts";
import { VOLUME_TIERS, type VolumeTier } from "../src/lib/monitor/volume-tiers.ts";
import { resolveFloors, resolveTierBaselines } from "../src/lib/monitor/settings.ts";
import { binomialFloor, carriedAnchor, type AnchorSource } from "../src/lib/monitor/carried-share.ts";
import { FLOOR_FIT } from "../src/lib/monitor/volume-floors.ts";
import { TIER_MEASUREMENTS } from "../src/lib/monitor/volume-tiers.ts";
import { runTierVolumeChecks } from "../src/lib/monitor/tier-volume.ts";
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

/**
 * An anchor source whose anchors are exactly `record`, before a share is measured and
 * at a share of 1 (#2893): each is listed as its tier's whole measurement, so thinning
 * it to 1 leaves it as it is. Every case below written before shares existed passes
 * one of these, and the harness's cal.com is switched off (a share of 1), so those
 * cases keep meaning what they meant.
 */
function sourceOf(record: Partial<Record<VolumeTier, VolumeBaseline>>): AnchorSource {
  return {
    unmeasured: record,
    measurements: Object.fromEntries(Object.entries(record).map(([t, b]) => [t, [{ ...b!, tierShare: null }]])),
  };
}

// Anchors as they stood before #2888 measured the tiers beside Low: the cases
// about a tier nobody measured pass this, so they keep meaning that whatever
// the real measurements hold today (L439).
const LOW_ONLY: AnchorSource = sourceOf({ "1": MEASURED_VOLUME_BASELINE });

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
  /** cal.com's counts per tier; null (the default) is cal.com switched off, a share of 1. */
  calcom?: Partial<Record<VolumeTier, number>> | null;
  calcomThrows?: boolean;
  source?: AnchorSource;
  /** When cal.com was marked retired (#3896), or null (the default) for never. */
  calcomRetiredAt?: string | null;
}) {
  const reads: { sinceIso: string; untilIso: string }[] = [];
  const firstReads: string[] = [];
  const closedReads: string[] = [];
  const saves: StoredVolumeLearning[] = [];
  const run = () =>
    runVolumeRelearn({
      nowMs: opts.nowMs ?? NOW,
      anchors: opts.source ?? sourceOf(opts.anchors ?? { "1": anchor(0, 4) }),
      zone: ZONE,
      readConfig: async () => {
        if (opts.configThrows) throw new Error("config read failed");
        return { rampEndOn: opts.rampEndOn ?? null, learning: opts.learning ?? null, calcomRetiredAt: opts.calcomRetiredAt ?? null };
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
      readCalcomTierCounts: async () => {
        if (opts.calcomThrows) throw new Error("cal.com read failed");
        if (opts.calcom === undefined || opts.calcom === null) return null;
        return { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, ...opts.calcom };
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
  const mediumNow = baselineInForce({ rampEndOn: null, learning: saved }, "2", LOW_ONLY);
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
  const mediumNow = baselineInForce({ rampEndOn: null, learning: widened.saves[0] }, "2", LOW_ONLY);
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
  const mediumSoon = baselineInForce({ rampEndOn: null, learning: soon.saves[0] }, "2", LOW_ONLY);
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
    anchors: sourceOf({ "1": anchor(0, 4) }),
    zone: ZONE,
    readConfig: async () => ({ rampEndOn: null, learning: null }),
    readFirstBookings: async () => ({ "1": LOW_FIRST }),
    readBookings: async () => low,
    readClosedDates: async () => [],
    readCalcomTierCounts: async () => null,
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
  const inForce = baselineInForce({ rampEndOn: null, learning: lowered }, "1", sourceOf({ "1": anchor(1, 11) }));
  eq(inForce.kind, "learned", "a stored learned result is in force");
  const tuesday2pm = DateTime.fromISO("2027-01-05T14:10", { zone: ZONE }).toMillis();
  if (inForce.kind === "learned") {
    const floors = floorsFor({ baseline: inForce.baseline, override30: null, override120: null }, tuesday2pm);
    eq(floors.floor120, 11, "a learned 2 hour floor below the cal.com floor is judged at the cal.com floor");
    eq(floors.floor30, 1, "and so is the 30 minute floor");
  }
  const aboveAnchor = baselineInForce({ rampEndOn: null, learning: fitted }, "1", sourceOf({ "1": anchor(0, 1) }));
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
  const tiers = resolveTierBaselines({ volume_ramp_end_on: null, volume_learning: widened.saves[0] }, LOW_ONLY);
  eq(Object.keys(tiers), ["2"], "the tiers judged beside Low are exactly the learned ones");
  eq(tiers["2"]?.source, "slate", "each with its own learned floors");
  eq(Object.keys(resolveTierBaselines({ volume_ramp_end_on: null, volume_learning: fitted })), [], "control: with only Low carried there are none");
}

// --- #2888: a non Low tier's cal.com anchor is a FLOOR ONLY ---
//
// Dan, 2026-09-29: the anchor never makes a tier judged. A carried tier beside Low
// is judged only once four weeks of its own bookings are learned, exactly as #2891
// shipped, and from then on no learned floor falls below its anchor. The pilot may
// move only some of a tier's pages, and judging that partial traffic against whole
// tier floors false pages (108 to 283 times in two normal weeks, measured in
// scripts/lib/volume-floor-scope.ts). Low keeps its own behaviour.
{
  const ANCHORED_RECORD: Partial<Record<VolumeTier, VolumeBaseline>> = { "1": MEASURED_VOLUME_BASELINE, "2": anchor(1, 7), "3": anchor(1, 5) };
  const ANCHORED = sourceOf(ANCHORED_RECORD);

  // One booking in: carried, anchored, and NOT judged.
  const oneIn = MEDIUM_FIRST + 60 * MIN;
  const first = harness({
    rows: [...low.filter((b) => b.createdAtMs < oneIn), ...bookings(MEDIUM_FIRST, MEDIUM_FIRST + 1, 10, "2")],
    first: { "1": LOW_FIRST, "2": MEDIUM_FIRST },
    nowMs: oneIn,
    anchors: ANCHORED_RECORD,
  });
  await first.run();
  const config = { volume_ramp_end_on: null, volume_learning: first.saves[0] };
  eq(first.saves[0]!.tiers["2"]?.rampStartAt, new Date(MEDIUM_FIRST).toISOString(), "Medium is carried from its one booking");
  eq(Object.keys(resolveTierBaselines(config, ANCHORED)), [], "an anchored Medium with one booking is NOT judged: its anchor is a floor, not a judge");
  eq(
    Object.keys(resolveTierBaselines({ volume_ramp_end_on: "2026-12-07", volume_learning: first.saves[0] }, ANCHORED)),
    [],
    "nor under a changed ramp end while its refit is pending",
  );

  // Two weeks in: still learning, still not judged.
  const early = MEDIUM_FIRST + 2 * WEEK;
  const soon = harness({
    rows: [...low, ...medium].filter((b) => b.createdAtMs < early),
    first: { "1": LOW_FIRST, "2": MEDIUM_FIRST },
    nowMs: early,
    anchors: ANCHORED_RECORD,
  });
  await soon.run();
  eq(Object.keys(resolveTierBaselines({ volume_ramp_end_on: null, volume_learning: soon.saves[0] }, ANCHORED)), [], "two weeks in it is still not judged");

  // Learned: judged, and every floor at least the anchor.
  const widened = harness({ rows: [...low, ...medium], first: { "1": LOW_FIRST, "2": MEDIUM_FIRST }, source: LOW_ONLY });
  await widened.run();
  const learned = resolveTierBaselines({ volume_ramp_end_on: null, volume_learning: widened.saves[0] }, ANCHORED);
  eq(Object.keys(learned), ["2"], "once four weeks of its own bookings are learned, Medium IS judged");
  eq(learned["2"]?.source, "slate", "against its own learned floors");
  assert(
    learned["2"]!.cells.every((d) => d.every((c) => c.floor120 >= 7 && c.floor30 >= 1)),
    "held at or above its cal.com anchor in every cell",
  );
  const bare = resolveTierBaselines({ volume_ramp_end_on: null, volume_learning: widened.saves[0] }, LOW_ONLY);
  assert(
    bare["2"]!.cells.some((d) => d.some((c) => c.floor120 < 7)),
    "control: without the anchor some learned floor sits below it, so the hold above is the anchor's doing",
  );

  // Low unchanged: judged against its measurement before it is learned, and its
  // learned floors are its own once they are.
  const lowYoung = resolveFloors({ floor_30: null, floor_120: null, volume_ramp_end_on: null, volume_learning: first.saves[0] }, {});
  eq(lowYoung.baseline.source, "calcom", "Low, not yet learned, is still judged against its cal.com measurement");
  const lowLearned = resolveFloors({ floor_30: null, floor_120: null, volume_ramp_end_on: null, volume_learning: widened.saves[0] }, {});
  eq(lowLearned.baseline.source, "slate", "and against its learned floors once learned");

  // The admin page, through the same predicate: learning with a floor under it, never "judged".
  const youngLines = tierLearningLines({ rampEndOn: null, learning: soon.saves[0] }, early + MIN, ANCHORED);
  assert(
    /^Medium: learning from its own bookings since its first real booking on .*, with its cal\.com measurement from Sep 25, 2026 as the floor under what it learns\. Not judged until 4 full weeks are learned \(2 so far\), so until then a drop in Medium bookings is not caught\.$/.test(youngLines[0]!),
    `an anchored tier still learning says so, with its floor (${youngLines[0]})`,
  );
  assert(!/judged against/.test(youngLines[0]!), "and never says it is judged against the measurement");
  assert(/^High: no real booking yet, so not carried and not judged\.$/.test(youngLines[1]!), `a measured tier nobody booked is not carried (${youngLines[1]})`);
  const learnedLines = tierLearningLines({ rampEndOn: null, learning: widened.saves[0] }, NOW + MIN, ANCHORED);
  assert(
    /^Medium: judged against floors learned from its own bookings since .*, none below its cal\.com measurement from Sep 25, 2026, last refit /.test(learnedLines[0]!),
    `a learned anchored tier names the floor under its floors (${learnedLines[0]})`,
  );
  const bareLines = tierLearningLines({ rampEndOn: null, learning: soon.saves[0] }, early + MIN, LOW_ONLY);
  assert(/^Medium: carried since .*, and not judged until 4 full weeks/.test(bareLines[0]!), `control: an unanchored tier keeps its line (${bareLines[0]})`);
  // With nothing stored no share has been measured, so the REAL source gives exactly
  // the anchors that were armed before #2893: Low's measurement alone.
  eq(tierLearningLines({ rampEndOn: null, learning: null }, NOW), tierLearningLines({ rampEndOn: null, learning: null }, NOW, LOW_ONLY), "nothing stored: the real anchors give the tier lines of a Low only world");
  eq(Object.keys(resolveTierBaselines({ volume_ramp_end_on: null, volume_learning: null })), [], "and judge no tier beside Low");
  // Once a share IS stored (here cal.com off, a share of 1), the real source puts
  // Medium's own saved measurement under its learned floors (#2893).
  const realLines = tierLearningLines({ rampEndOn: null, learning: widened.saves[0] }, NOW + MIN);
  assert(
    /^Medium: judged against floors learned from its own bookings since .*, none below its cal\.com measurement from Sep 29, 2026, last refit /.test(realLines[0]!),
    `with a share stored, Medium's own measurement is under its floors (${realLines[0]})`,
  );
  for (const line of [...youngLines, ...learnedLines, ...bareLines]) {
    assert(!/undefined|NaN|null|\[object/.test(line), `no leaked value in "${line.slice(0, 50)}"`);
    assert(!/[\u2014\u2013]/.test(line), "no dashes in the copy");
  }
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
  const lines = tierLearningLines({ rampEndOn: null, learning: widened.saves[0] }, NOW + MIN, LOW_ONLY);
  eq(lines.length, VOLUME_TIERS.length - 1, "one line for every tier beside Low");
  assert(/^Medium: judged against floors learned from its own bookings/.test(lines[0]!), `a learned tier says so (${lines[0]})`);
  assert(/^High: carried since .*, and not judged until 4 full weeks/.test(lines[1]!), `a young tier says when it will be judged (${lines[1]})`);
  assert(/^Very High: no real booking yet, so not carried and not judged\.$/.test(lines[2]!), `a tier nobody booked says so (${lines[2]})`);
  const unreadLines = tierLearningLines({ rampEndOn: null, learning: "nonsense" }, NOW, LOW_ONLY);
  assert(unreadLines.every((l) => /could not be read/.test(l)), "an unreadable result says so for every tier rather than calling them not carried");
  for (const c of [none, notCarried, learned, overdue, unreadable]) {
    for (const line of [c.inForce, ...c.detail, ...lines, ...unreadLines]) {
      assert(!/undefined|NaN|null|\[object/.test(line), `no leaked value in "${line.slice(0, 50)}"`);
      assert(!/[\u2014\u2013]/.test(line), "no dashes in the copy");
    }
  }
}

// --- #2893: each tier's cal.com measurement, thinned to the share Slate carries ---
//
// Low bookings arrive every 5 minutes, 288 in the day before the refit. cal.com took
// as many again, so Slate carried half of Low that day.
{
  const WHOLE = sourceOf({ "1": anchor(1, 20) });
  const half = harness({ rows: low, calcom: { "1": 288 }, source: WHOLE });
  await half.run();
  const share = half.saves[0]!.carriedShare!.tiers["1"]!;
  eq(share.applied?.share, 0.5, "the refit measures Slate's share of Low: 288 of 576");
  eq([share.applied?.slate, share.applied?.calcom], [288, 288], "counting Slate's own rows and cal.com's answer over the same day");
  eq(share.last.outcome, "applied", "and applies it, with nothing before it to protect");
  const inForce = baselineInForce({ rampEndOn: null, learning: half.saves[0] }, "1", WHOLE);
  eq(inForce.anchor?.cells[1]![14]!.floor120, binomialFloor(20, 0.5, FLOOR_FIT.poissonAlpha), "the anchor read back is the measurement thinned to that share");
  eq(inForce.share?.applied?.share, 0.5, "and the state says which share it is at");

  // THE ISSUE ITSELF: a whole tier anchor under partial traffic raises the learned
  // floors past what that traffic clears. Thinned, it does not.
  const full = harness({ rows: low, source: WHOLE }); // cal.com off: a share of 1
  await full.run();
  const fullIn = baselineInForce({ rampEndOn: null, learning: full.saves[0] }, "1", WHOLE);
  assert(fullIn.kind === "learned" && fullIn.baseline.cells.every((d) => d.every((c) => c.floor120 >= 20)), "control: at a share of 1 every learned floor is raised to the whole anchor's 20");
  assert(inForce.kind === "learned" && inForce.baseline.cells.some((d) => d.some((c) => c.floor120 < 20)), "at half, the learned floors are no longer raised to traffic Slate does not carry");
  const fitTime = half.saves[0]!.tiers["1"]!.result;
  assert(
    (fitTime?.status === "learned" || fitTime?.status === "declining") && fitTime.baseline.cells.some((d) => d.some((c) => c.floor120 < 20)),
    "and the fit itself underpinned with the thinned anchor, the same one the read uses",
  );

  // Slate breaks the next day: its bookings stop and cal.com does NOT take them.
  const nextDay = NOW + DAY;
  const lost = harness({ rows: low, calcom: { "1": 288 }, source: WHOLE, learning: half.saves[0], nowMs: nextDay });
  await lost.run();
  const held = lost.saves[0]!.carriedShare!.tiers["1"]!;
  eq(held.last.outcome, "held", "a share that fell with the tier's whole traffic is HELD: those bookings were lost, not moved");
  eq(held.applied?.share, 0.5, "the half share stays in force");
  eq(held.last.slate, 0, "while the reading itself is kept, to say what was seen");
  const heldIn = baselineInForce({ rampEndOn: null, learning: lost.saves[0] }, "1", WHOLE);
  eq(heldIn.anchor?.cells[1]![14]!.floor120, binomialFloor(20, 0.5, FLOOR_FIT.poissonAlpha), "so the floors watching the outage do not drop with it");
  // Control: the same drop, with cal.com taking the leads Slate stopped getting.
  const moved = harness({ rows: low, calcom: { "1": 576 }, source: WHOLE, learning: half.saves[0], nowMs: nextDay });
  await moved.run();
  eq(moved.saves[0]!.carriedShare!.tiers["1"]!.applied?.share, 0, "control: when cal.com took them, the leads MOVED and the new share applies");

  // #3193: the share in force as the per page alarm reads it, one state per cause.
  // The page floors have no measurement of their own to fall back on, so a share
  // that is not known must say which way it is not known, never stand in as 1 or 0.
  eq(shareInForce(half.saves[0], "1"), { state: "applied", share: 0.5, heldSince: null, countedTo: half.saves[0]!.carriedShare!.tiers["1"]!.applied!.to }, "an applied share is read as applied");
  const heldShare = shareInForce(lost.saves[0], "1");
  assert(heldShare.state === "applied" && heldShare.share === 0.5 && heldShare.heldSince !== null, "a held share is the share in force, marked held since when");
  eq(shareInForce(null, "1"), { state: "unmeasured" }, "no refit stored is unmeasured");
  eq(shareInForce(half.saves[0], "2"), { state: "unmeasured" }, "a tier with no share entry is unmeasured");
  eq(shareInForce({ ...half.saves[0]!, carriedShare: null }, "1"), { state: "unmeasured" }, "a refit that measured no share yet is unmeasured");
  eq(shareInForce("nonsense", "1"), { state: "unreadable" }, "a record that does not read is unreadable, not unmeasured (L11)");

  // A failed or partial cal.com read writes nothing and leaves the floors in force.
  const broken = harness({ rows: low, calcomThrows: true, source: WHOLE });
  assert(await rejects(broken.run(), /cal\.com read failed/), "a cal.com read that fails fails the refit");
  eq(broken.saves.length, 0, "and writes nothing");
  const garbled = harness({ rows: low, calcom: { "3": Number.NaN }, source: WHOLE });
  assert(await rejects(garbled.run(), /tier 3/), "a cal.com answer with an unreadable tier is refused by name (L214)");
  eq(garbled.saves.length, 0, "and writes nothing");

  // Nothing carried: cal.com is not asked, and the shares last measured are kept.
  const none = harness({ rows: [], first: {}, calcomThrows: true, learning: half.saves[0], source: WHOLE, nowMs: nextDay });
  await none.run();
  eq(none.saves[0]!.carriedShare, half.saves[0]!.carriedShare, "with no tier carried, cal.com is never read and the stored shares stand");
}

// Low before it has learned, through the resolver the monitor uses, with the REAL
// measurements: at half the pilot pages' traffic, Low's two page fit is thinned.
{
  const young = LOW_FIRST + 2 * WEEK;
  const h = harness({ rows: low.filter((b) => b.createdAtMs < young), calcom: { "1": 288 }, source: undefined, nowMs: young });
  await h.run();
  const set = resolveFloors({ floor_30: null, floor_120: null, volume_ramp_end_on: null, volume_learning: h.saves[0] }, {});
  const expected = carriedAnchor(TIER_MEASUREMENTS["1"], 0.5)!;
  eq(set.baseline.cells, expected.cells, "Low, not yet learned, is judged against its measurement thinned to the share");
  eq(expected.scope.startsWith(MEASURED_VOLUME_BASELINE.scope), true, "which is the two page fit, the narrowest that covers half of Low");
  assert(set.baseline.cells.some((d, i) => d.some((c, j) => c.floor120 < MEASURED_VOLUME_BASELINE.cells[i]![j]!.floor120)), "and lower than the untouched fit somewhere");
  const unmeasured = resolveFloors({ floor_30: null, floor_120: null, volume_ramp_end_on: null, volume_learning: null }, {});
  eq(unmeasured.baseline, MEASURED_VOLUME_BASELINE, "control: with no share measured Low keeps exactly the fit that was armed");
  const detail = learningStatusCopy(baselineInForce({ rampEndOn: null, learning: h.saves[0] }, "1"), young + MIN).detail.join(" ");
  assert(/Slate carried 50% of Low bookings in the day to .* \(288 of 576 across Slate and cal\.com\), so the cal\.com floors under Low are thinned to that share\./.test(detail), `the page says the share and what it did (${detail})`);
}

// --- the stored shape: version 2 still reads, and a version 3 record is validated ---
{
  const v2 = JSON.parse(JSON.stringify(fitted)) as Record<string, unknown>;
  v2.version = 2;
  delete v2.carriedShare;
  const read = readStoredLearning(v2);
  eq(read.state, "ok", "a version 2 record, from before shares existed, still reads (L1010)");
  if (read.state === "ok") {
    eq(read.legacy, true, "as legacy, so the next tick refits and measures the shares");
    eq(read.value.carriedShare, null, "with no share measured");
  }
  const fresh = harness({ rows: low, learning: { ...v2, fittedAt: new Date(NOW - MIN).toISOString() } });
  eq((await fresh.run()).status, "refit", "a fresh version 2 record is refit at once rather than waiting out the day");
  const noField = JSON.parse(JSON.stringify(fitted)) as Record<string, unknown>;
  delete noField.carriedShare;
  eq(readStoredLearning(noField).state, "unreadable", "a version 3 record with no share field is malformed, not 'none measured'");
  eq(readStoredLearning({ ...(fitted as object), carriedShare: { measuredAt: "soon" } }).state, "unreadable", "and so is one whose shares do not validate");
}

// --- #3896: the cal.com anchor retires a set time after cal.com is marked retired ---
//
// After cutover cal.com takes nothing, so the share is 1 for good and the anchor is
// the tier's whole cal.com measurement for ever. A deliberate cut to Medium, High or
// Very High, which have no floor override, would then page every day. Dan,
// 2026-10-23: the anchor stops applying ANCHOR_OVERLAP_WEEKS after cal.com is marked
// retired, so the learned floors follow Slate's own traffic. Driven end to end: the
// refit, the resolver the monitor reads, and the tier check that pages.
{
  const RETIRED = DateTime.fromISO("2027-01-04T11:00", { zone: ZONE }).toMillis(); // a Monday
  const RETIRED_AT = new Date(RETIRED).toISOString();
  const MED_START = RETIRED - 12 * WEEK;
  // Medium's whole tier measurement: a 2 hour floor of 20, which full traffic (30
  // bookings in 2 hours) clears and the deliberately halved traffic (15) does not.
  const MED_ANCHORED = sourceOf({ "1": anchor(0, 4), "2": anchor(4, 20) });
  const HOURS = {
    zone: ZONE,
    rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 24 * 60 })),
    exceptions: [],
  };
  /** Refit at `nowMs`, then run the tier check the monitor runs, and return what it paged. */
  async function judgeMedium(rows: SlateBookingRow[], nowMs: number, calcomRetiredAt: string | null) {
    const h = harness({ rows, first: { "2": MED_START }, nowMs, source: MED_ANCHORED, calcomRetiredAt });
    await h.run();
    const config = { volume_ramp_end_on: null, volume_learning: h.saves[0], calcom_retired_at: calcomRetiredAt };
    const baselines = resolveTierBaselines(config, MED_ANCHORED);
    const sent: string[] = [];
    await runTierVolumeChecks({
      nowMs,
      businessHours: HOURS,
      baselines,
      countSince: async (tier, sinceIso) =>
        rows.filter((r) => r.tier === tier && r.createdAtMs >= Date.parse(sinceIso) && r.createdAtMs < nowMs).length,
      armed: true,
      cooldownMs: 30 * MIN,
      notify: async (key) => void sent.push(key),
      notifyCountUnreadable: async (key) => void sent.push(key),
      resolveRecovered: async () => [],
    });
    const state = baselineInForce({ rampEndOn: null, learning: h.saves[0], calcomRetiredAt }, "2", MED_ANCHORED);
    return { sent, saved: h.saves[0]!, baselines, state };
  }
  const CUT = RETIRED + WEEK; // Pennie deliberately halves Medium a week after cutover
  const cutRows = (until: number) => [...bookings(MED_START, CUT, 4, "2"), ...bookings(CUT, until, 8, "2")];

  assert(ANCHOR_OVERLAP_WEEKS >= LEARNING.horizonWeeks, `the overlap (${ANCHOR_OVERLAP_WEEKS} weeks) covers the learner's whole horizon (${LEARNING.horizonWeeks}), so it learns from post cutover weeks alone`);

  // Inside the overlap, the anchor holds the floor up: the halved traffic pages.
  const inside = RETIRED + 8 * WEEK + 3 * 60 * MIN;
  assert(inside < RETIRED + ANCHOR_OVERLAP_WEEKS * WEEK, "the first check is inside the overlap");
  const held = await judgeMedium(cutRows(inside), inside, RETIRED_AT);
  assert(held.baselines["2"]!.cells.every((d) => d.every((c) => c.floor120 >= 20)), "inside the overlap every Medium floor is held at the cal.com measurement");
  eq(held.sent, ["low_tier_volume:2"], "so the deliberately halved Medium pages, as it always has");
  assert(held.state.kind === "learned" && held.state.anchored, "and the state says the anchor is under it");

  // After it, the cut is learned and the same traffic does not page.
  const after = RETIRED + 10 * WEEK + 3 * 60 * MIN;
  assert(after >= RETIRED + ANCHOR_OVERLAP_WEEKS * WEEK, "the second check is past the overlap");
  const learned = await judgeMedium(cutRows(after), after, RETIRED_AT);
  eq(learned.saved.tiers["2"]?.result?.status, "learned", "past the overlap the halved weeks are learned as Medium's traffic");
  assert(learned.baselines["2"]!.cells.some((d) => d.some((c) => c.floor120 < 20)), "with floors below the retired cal.com measurement");
  eq(learned.sent, [], "and the deliberately halved Medium no longer pages");
  assert(learned.state.kind === "learned" && !learned.state.anchored, "the state says no anchor is under it");
  const fit = learned.saved.tiers["2"]?.result;
  assert(
    (fit?.status === "learned" || fit?.status === "declining") && fit.baseline.cells.some((d) => d.some((c) => c.floor120 < 20)),
    "the fit itself left the anchor out, the same decision the read makes",
  );

  // Control: with cal.com never marked retired the anchor never retires, which is the gap.
  const never = await judgeMedium(cutRows(after), after, null);
  eq(never.sent, ["low_tier_volume:2"], "control: with no retirement date the anchor holds for good and the halved Medium pages");

  // Control: an unexplained collapse after retirement still pages.
  const full = bookings(MED_START, after - 2 * 60 * MIN, 4, "2");
  const collapse = await judgeMedium(full, after, RETIRED_AT);
  eq(collapse.saved.tiers["2"]?.result?.status, "learned", "bookings that stopped two hours ago are not yet anything the fit saw");
  eq(collapse.sent, ["low_tier_volume:2"], "control: Medium stopping outright after retirement still pages");
  // And a fall the horizon has not absorbed is held off by the decline guard.
  const fell = [...bookings(MED_START, after - 2 * WEEK, 4, "2"), ...bookings(after - 2 * WEEK, after, 20, "2")];
  const declining = await judgeMedium(fell, after, RETIRED_AT);
  eq(declining.saved.tiers["2"]?.result?.status, "declining", "a fall to a fifth over the last two weeks is a decline, not learned");
  eq(declining.sent, ["low_tier_volume:2"], "control: and it pages against the floors from before it");

  // The read follows the fit: a result fitted inside the overlap keeps its anchor
  // until the next refit, and putting cal.com back restores the anchor at once.
  const readLater = baselineInForce({ rampEndOn: null, learning: held.saved, calcomRetiredAt: RETIRED_AT }, "2", MED_ANCHORED);
  assert(readLater.kind === "learned" && readLater.anchored, "a result fitted inside the overlap is read with its anchor, whenever it is read");
  const putBack = baselineInForce({ rampEndOn: null, learning: learned.saved, calcomRetiredAt: null }, "2", MED_ANCHORED);
  assert(
    putBack.kind === "learned" && putBack.anchored && putBack.baseline.cells.every((d) => d.every((c) => c.floor120 >= 20)),
    "cal.com put back: the anchor is under the floors again from the next read",
  );
  const unreadable = baselineInForce({ rampEndOn: null, learning: learned.saved, calcomRetiredAt: "not a date" }, "2", MED_ANCHORED);
  assert(unreadable.kind === "learned" && unreadable.anchored, "a retirement date that does not read keeps the anchor (L50)");

  // The admin page says it ONCE, under the tier list, for every tier with Low
  // included (Dan's design round, 2026-10-23: "Once, under the tiers"), and never on
  // a tier line or in Low's status. Low is carried here too, so its status is real.
  const both = async (nowMs: number) => {
    const h = harness({
      rows: [...cutRows(nowMs), ...bookings(MED_START, nowMs, 5, "1")],
      first: { "1": MED_START, "2": MED_START },
      nowMs,
      source: MED_ANCHORED,
      calcomRetiredAt: RETIRED_AT,
    });
    await h.run();
    const input = { rampEndOn: null, learning: h.saves[0], calcomRetiredAt: RETIRED_AT };
    return {
      sentence: anchorRetirementSentence(input),
      tierLine: tierLearningLines(input, nowMs + MIN, MED_ANCHORED)[0]!,
      lowStatus: learningStatusCopy(baselineInForce(input, "1", MED_ANCHORED), nowMs + MIN),
      input,
    };
  };
  const before = await both(inside);
  eq(
    before.sentence,
    "cal.com was marked retired on Jan 4, 2027. From Mar 8, 2027, 9 weeks later, its measurement stops holding any floor up, and every tier, Low included, follows Slate's own bookings.",
    "inside the overlap one sentence under the tiers says when the anchor stops",
  );
  assert(/none below its cal\.com measurement/.test(before.tierLine), `inside the overlap the tier line still names the floor under it (${before.tierLine})`);
  const pastCut = await both(after);
  eq(
    pastCut.sentence,
    "No cal.com measurement has held any floor up since Mar 8, 2027, 9 weeks after cal.com was marked retired, so every tier, Low included, follows Slate's own bookings.",
    "past it the same place says since when no cal.com measurement is under any floor",
  );
  assert(
    /^Medium: judged against floors learned from its own bookings since .*, last refit [^.]*\.$/.test(pastCut.tierLine) && !/cal\.com/.test(pastCut.tierLine),
    `past it the tier line stops mentioning the cal.com measurement (${pastCut.tierLine})`,
  );
  for (const view of [before, pastCut]) {
    const lines = [view.tierLine, view.lowStatus.inForce, ...view.lowStatus.detail];
    assert(
      lines.every((l) => !/marked retired|stops holding|held any floor/.test(l)),
      `the retirement is said once, never on a tier line or Low's status (${lines.join(" | ")})`,
    );
  }
  assert(
    pastCut.lowStatus.detail.every((l) => !/applies in full|No floor is below/.test(l)),
    "Low's status claims no cal.com floor under it once the anchor has gone",
  );
  eq(anchorRetirementSentence({ rampEndOn: null, learning: held.saved, calcomRetiredAt: null }), null, "control: with cal.com not marked retired there is no sentence");
  // The ramp end confirm's claim about Low's floors, from the same retirement state.
  eq(rampEndLowFloorNote(before.input), "Low's never go below the cal.com floors before Mar 8, 2027.", "inside the overlap the confirm says until when Low is held up");
  eq(rampEndLowFloorNote(pastCut.input), null, "past it the confirm claims no cal.com floor under Low");
  eq(rampEndLowFloorNote({ rampEndOn: null, learning: held.saved, calcomRetiredAt: null }), "Low's never go below the cal.com floors.", "control: with cal.com live it says so plainly");
  const lowState = baselineInForce({ rampEndOn: null, learning: learned.saved, calcomRetiredAt: RETIRED_AT }, "1", MED_ANCHORED);
  eq(lowState.kind, "measured", "control: Low, which the refit found not carried, is still judged against its measurement");
  for (const line of [before.sentence ?? "", pastCut.sentence ?? "", before.tierLine, pastCut.tierLine]) {
    assert(!/undefined|NaN|null|\[object/.test(line), `no leaked value in "${line.slice(0, 50)}"`);
    assert(/^[\x20-\x7E]*$/.test(line), "plain ASCII copy, so no dashes or emoji");
  }
  // The settled design draws its sentence from the same constant.
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "docs", "design", "fixtures", "alerts-learning-retirement.json"), "utf8"),
  ) as { overlapWeeks: number };
  eq(fixture.overlapWeeks, ANCHOR_OVERLAP_WEEKS, "the design fixture's overlap is the constant's");

  // The runbook says when the anchor stops applying, in the constant's own number.
  const runbook = readFileSync(join(import.meta.dirname, "..", "docs", "alerts-runbook.md"), "utf8");
  assert(runbook.includes("ANCHOR_OVERLAP_WEEKS") && runbook.includes(`${ANCHOR_OVERLAP_WEEKS} weeks after cal.com is marked retired`), "docs/alerts-runbook.md names the overlap and its length");
}

finish();

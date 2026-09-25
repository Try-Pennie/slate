// #2739: wiring the low volume learner (#1956 phase 2) to a stored ramp end and to
// Slate's own bookings, refit on the monitor lane once a day.
// Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-volume-relearn.ts
//
// What this pins, each with a control (L159):
// - INERT BEFORE CUTOVER. No ramp end, no read, no write, and the cal.com
//   measurement is the baseline in force, however much is stored beside it.
// - A FAILED READ OR WRITE LEAVES THE FLOORS IN FORCE. The step throws (so the
//   lane's step boundary pages and logs it), nothing is written, and the baseline
//   in force is unchanged. Never a fallback to zero bookings (L105, L215).
// - THE CAL.COM FIT IS THE FLOOR UNDER THE LEARNED FLOOR, at READ time as well as at
//   fit time: a stored learned cell below the anchor is judged at the anchor.
// - A learned result belongs to the ramp end it was fitted for; changing the ramp
//   end takes it out of force and makes a refit due at once.
import { DateTime } from "luxon";
import {
  REFIT_EVERY_MS,
  REFIT_OVERDUE_MS,
  baselineInForce,
  parseRampEndForm,
  rampEndMs,
  readStoredLearning,
  runVolumeRelearn,
  type StoredVolumeLearning,
} from "../src/lib/monitor/volume-relearn.ts";
import { learningStatusCopy } from "../src/lib/monitor/volume-relearn-copy.ts";
import { LEARNING, type SlateBookingRow } from "../src/lib/monitor/volume-learning.ts";
import { floorsFor, type FloorCell, type VolumeBaseline } from "../src/lib/monitor/volume-floors.ts";
import { MEASURED_VOLUME_BASELINE } from "../src/lib/monitor/volume-baseline.ts";
import { resolveFloors } from "../src/lib/monitor/settings.ts";
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

function bookings(from: number, to: number, everyMin: number, isTest = false): SlateBookingRow[] {
  const out: SlateBookingRow[] = [];
  for (let t = from; t < to; t += everyMin * MIN) out.push({ createdAtMs: t, isTest });
  return out;
}

/** A relearn harness with every seam recorded. */
function harness(opts: {
  rampEndOn: string | null;
  learning?: unknown;
  rows?: SlateBookingRow[];
  readThrows?: boolean;
  saveThrows?: boolean;
  configThrows?: boolean;
  anchorBaseline?: VolumeBaseline;
  nowMs?: number;
}) {
  const reads: { sinceIso: string; untilIso: string }[] = [];
  const saves: StoredVolumeLearning[] = [];
  const run = () =>
    runVolumeRelearn({
      nowMs: opts.nowMs ?? NOW,
      anchor: opts.anchorBaseline ?? anchor(0, 4),
      readConfig: async () => {
        if (opts.configThrows) throw new Error("config read failed");
        return { rampEndOn: opts.rampEndOn, learning: opts.learning ?? null };
      },
      readBookings: async (sinceIso, untilIso) => {
        reads.push({ sinceIso, untilIso });
        if (opts.readThrows) throw new Error("bookings read failed");
        return opts.rows ?? [];
      },
      save: async (state) => {
        if (opts.saveThrows) throw new Error("write refused");
        saves.push(state);
      },
    });
  return { run, reads, saves };
}

async function rejects(p: Promise<unknown>, message: RegExp): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (err) {
    return err instanceof Error && message.test(err.message);
  }
}

const steady = bookings(RAMP_END, NOW, 5);

// --- inert before a ramp end is declared ---
{
  const h = harness({ rampEndOn: null, rows: steady });
  const out = await h.run();
  eq(out.status, "no-ramp-end", "no ramp end: the relearn step does nothing");
  eq(h.reads.length, 0, "and reads no bookings");
  eq(h.saves.length, 0, "and writes nothing");
}

// --- control: a declared ramp end with no stored result refits now ---
let fitted: StoredVolumeLearning | null = null;
{
  const h = harness({ rampEndOn: RAMP_END_ON, rows: [...steady, ...bookings(RAMP_END, NOW, 60, true)] });
  const out = await h.run();
  eq(out.status, "refit", "a declared ramp end with nothing stored refits on this tick");
  eq(h.reads.length, 1, "with one read");
  eq(
    h.reads[0]!.sinceIso,
    new Date(NOW - LEARNING.horizonWeeks * WEEK).toISOString(),
    "that starts a full horizon back, so bookings before the ramp are counted as excluded rather than never seen",
  );
  eq(h.reads[0]!.untilIso, new Date(NOW).toISOString(), "and ends at the tick");
  eq(h.saves.length, 1, "and stores the result");
  fitted = h.saves[0]!;
  eq(fitted.rampEndOn, RAMP_END_ON, "the stored result names the ramp end it was fitted for");
  eq(fitted.result.status, "learned", "eight steady weeks are learned");
  if (fitted.result.status === "learned") {
    assert(fitted.result.excludedTest > 0, "test bookings were counted as excluded");
  }
}

// --- not due again inside a day, due after one ---
{
  const h = harness({ rampEndOn: RAMP_END_ON, learning: fitted, rows: steady, nowMs: NOW + REFIT_EVERY_MS - MIN });
  eq((await h.run()).status, "not-due", "a result younger than a day is not refit");
  eq(h.reads.length, 0, "and reads nothing");
  const later = harness({ rampEndOn: RAMP_END_ON, learning: fitted, rows: steady, nowMs: NOW + REFIT_EVERY_MS });
  eq((await later.run()).status, "refit", "a day later it is refit");
}

// --- changing the ramp end makes a refit due at once, and takes the old one out of force ---
{
  const h = harness({ rampEndOn: "2026-11-09", learning: fitted, rows: steady, nowMs: NOW + MIN });
  eq((await h.run()).status, "refit", "a new ramp end refits at once rather than waiting out the day");
  const inForce = baselineInForce({ rampEndOn: "2026-11-09", learning: fitted }, anchor(0, 4));
  eq(inForce.kind, "measured", "a result fitted for another ramp end is not in force");
  if (inForce.kind === "measured") eq(inForce.why, "other-ramp-end", "and says why");
}

// --- a failed read leaves the floors in force and says so ---
{
  const h = harness({ rampEndOn: RAMP_END_ON, learning: fitted, readThrows: true, nowMs: NOW + 2 * DAY });
  assert(await rejects(h.run(), /bookings read failed/), "a failed bookings read throws, so the lane's step boundary reports it");
  eq(h.saves.length, 0, "and nothing is written: the stored floors stay in force");
  const before = baselineInForce({ rampEndOn: RAMP_END_ON, learning: fitted }, anchor(0, 4));
  eq(before.kind, "learned", "the baseline in force is still the learned one");
  // Control: the same tick with a readable table writes.
  const ok = harness({ rampEndOn: RAMP_END_ON, learning: fitted, rows: steady, nowMs: NOW + 2 * DAY });
  eq((await ok.run()).status, "refit", "control: the same tick with a readable table refits");
}
{
  const h = harness({ rampEndOn: RAMP_END_ON, configThrows: true });
  assert(await rejects(h.run(), /config read failed/), "an unreadable ramp end throws rather than reading as no ramp end");
  eq(h.reads.length, 0, "and reads no bookings");
}
{
  const h = harness({ rampEndOn: RAMP_END_ON, rows: steady, saveThrows: true });
  assert(await rejects(h.run(), /write refused/), "a refused write throws rather than reporting a refit");
}
{
  // An EMPTY read is not a failure, and it must never become learned zero floors:
  // with nothing booked, learning is not "learned" at all below the anchor.
  const h = harness({ rampEndOn: RAMP_END_ON, rows: [], anchorBaseline: anchor(1, 9) });
  await h.run();
  const r = h.saves[0]!.result;
  if (r.status === "learned" || r.status === "declining") {
    assert(
      r.baseline.cells.every((d) => d.every((c) => c.floor120 >= 9 && c.floor30 >= 1)),
      "an empty table learns nothing below the cal.com floors",
    );
  } else {
    assert(true, `an empty table is ${r.status}, not a set of zero floors`);
  }
}

// --- the cal.com fit is the floor under the learned floor, at read time ---
{
  const low = JSON.parse(JSON.stringify(fitted)) as StoredVolumeLearning;
  if (low.result.status === "learned") {
    low.result.baseline.cells = low.result.baseline.cells.map((d) => d.map((c) => ({ ...c, floor30: 0, floor120: 2 })));
  }
  const high = anchor(1, 11);
  const inForce = baselineInForce({ rampEndOn: RAMP_END_ON, learning: low }, high);
  eq(inForce.kind, "learned", "a stored learned result is in force");
  const tuesday2pm = DateTime.fromISO("2027-01-05T14:10", { zone: ZONE }).toMillis();
  const floors = floorsFor({ baseline: inForce.baseline, override30: null, override120: null }, tuesday2pm);
  eq(floors.floor120, 11, "a learned 2 hour floor below the cal.com floor is judged at the cal.com floor");
  eq(floors.floor30, 1, "and so is the 30 minute floor");
  // Control: a learned floor ABOVE the anchor is kept.
  const aboveAnchor = baselineInForce({ rampEndOn: RAMP_END_ON, learning: fitted }, anchor(0, 1));
  const kept = floorsFor({ baseline: aboveAnchor.baseline, override30: null, override120: null }, tuesday2pm);
  assert(kept.floor120 > 1, "control: a learned floor above the cal.com floor is kept as learned");
}

// --- through the SAME resolver the monitor and the admin page use ---
{
  const none = resolveFloors({ floor_30: null, floor_120: null, volume_ramp_end_on: null, volume_learning: fitted }, {});
  eq(none.baseline.source, "calcom", "no ramp end: the resolver serves the cal.com measurement even with a result stored");
  const set = resolveFloors({ floor_30: null, floor_120: null, volume_ramp_end_on: RAMP_END_ON, volume_learning: fitted }, {});
  eq(set.baseline.source, "slate", "a ramp end and a result fitted for it: the resolver serves the learned floors");
  const overridden = resolveFloors({ floor_30: 3, floor_120: null, volume_ramp_end_on: RAMP_END_ON, volume_learning: fitted }, {});
  eq(overridden.override30?.value, 3, "an override still replaces the floor it names");
}

// --- insufficient history keeps the cal.com floors in force ---
{
  const soon = RAMP_END + 2 * WEEK;
  const h = harness({ rampEndOn: RAMP_END_ON, rows: bookings(RAMP_END, soon, 5), nowMs: soon });
  await h.run();
  eq(h.saves[0]!.result.status, "insufficient", "two weeks after the ramp is not enough");
  const inForce = baselineInForce({ rampEndOn: RAMP_END_ON, learning: h.saves[0] }, MEASURED_VOLUME_BASELINE);
  eq(inForce.kind, "measured", "and the cal.com measurement stays in force");
  if (inForce.kind === "measured") eq(inForce.why, "insufficient", "saying why");
}

// --- a stored value that is not a result reads as unreadable, never as floors ---
{
  for (const bad of [{ version: 9 }, { version: 1, rampEndOn: RAMP_END_ON, fittedAt: "x", result: { status: "learned" } }, "nonsense", 7]) {
    eq(readStoredLearning(bad).state, "unreadable", `a malformed stored result is unreadable (${JSON.stringify(bad).slice(0, 40)})`);
  }
  const missingCell = JSON.parse(JSON.stringify(fitted)) as StoredVolumeLearning;
  if (missingCell.result.status === "learned") missingCell.result.baseline.cells[3]!.pop();
  eq(readStoredLearning(missingCell).state, "unreadable", "a learned result missing one hour is unreadable, not a zero floor");
  eq(readStoredLearning(null).state, "none", "null is nothing stored");
  eq(readStoredLearning(fitted).state, "ok", "control: a real stored result reads");
  const inForce = baselineInForce({ rampEndOn: RAMP_END_ON, learning: "nonsense" }, MEASURED_VOLUME_BASELINE);
  eq(inForce.kind, "measured", "an unreadable result leaves the cal.com measurement in force");
  if (inForce.kind === "measured") eq(inForce.why, "unreadable", "and says so");
  const h = harness({ rampEndOn: RAMP_END_ON, learning: "nonsense", rows: steady });
  eq((await h.run()).status, "refit", "and the next tick refits over it");
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
  const bogus = parseRampEndForm({ intent: "set", rampEnd: "2026-02-30" });
  eq(bogus.ok, false, "an impossible date is refused");
  const unknown = parseRampEndForm({ intent: "", rampEnd: "2026-10-12" });
  eq(unknown.ok, false, "a press that names neither setting nor clearing is refused");
}

// --- the admin wording, one state at a time ---
{
  const at = (learning: unknown, rampEndOn: string | null, nowMs = NOW + MIN) =>
    learningStatusCopy(baselineInForce({ rampEndOn, learning }, MEASURED_VOLUME_BASELINE), nowMs);
  const none = at(null, null);
  assert(/cal\.com measurement from Sep 25, 2026/.test(none.inForce), `nothing declared names the cal.com measurement (${none.inForce})`);
  assert(/until the day the ramp ended is set/.test(none.detail.join(" ")), "and says what starts learning");
  const pending = at(null, RAMP_END_ON);
  assert(/next check/.test(pending.detail.join(" ")), `a declared ramp end with no refit yet says when it runs (${pending.detail})`);
  const learned = at(fitted, RAMP_END_ON);
  assert(/learned from Slate's own bookings/.test(learned.inForce), `a learned result names itself (${learned.inForce})`);
  assert(/last refit/.test(learned.inForce), "and when it was last refit");
  assert(/No floor is below the cal\.com measurement/.test(learned.detail.join(" ")), "and states the floor under the floor");
  const overdue = at(fitted, RAMP_END_ON, NOW + REFIT_OVERDUE_MS + MIN);
  assert(/No refit has succeeded since/.test(overdue.detail.join(" ")), `an old refit says refits are failing (${overdue.detail})`);
  const fresh = at(fitted, RAMP_END_ON, NOW + REFIT_OVERDUE_MS - MIN);
  assert(!/No refit has succeeded since/.test(fresh.detail.join(" ")), "control: a recent refit does not");
  const unreadable = at("nonsense", RAMP_END_ON);
  assert(/could not be read/.test(unreadable.detail.join(" ")), "an unreadable stored result says so");
  for (const c of [none, pending, learned, overdue, unreadable]) {
    for (const line of [c.inForce, ...c.detail]) {
      assert(!/undefined|NaN|null|\[object/.test(line), `no leaked value in "${line.slice(0, 50)}"`);
      assert(!/[\u2014\u2013]/.test(line), "no dashes in the copy");
    }
  }
}

finish();

// Booking pace on Team capacity (#4103): the capacity-fill lane writes each reading's pace and both
// estimates onto the row, which the day cards read (#4104).
//
// The rules a wrong answer would hide behind a plausible number:
//  - the stored columns are exactly what `pace` and `estimate` (capacity-pace.ts) say, so the card
//    can never show a pace the module did not compute;
//  - the pace counts the reading being written, and the day's stored readings before it;
//  - "readings missed" carries the half hour the pace returns, which the card names;
//  - a step's cell is the one a reading at that instant would be stamped with: its half hour of the
//    office's day and the day's position among the booker's days THEN, not at the reading.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-capacity-fill-pace.ts
import { DateTime } from "luxon";
import { assert, eq, finish } from "./lib/harness.ts";
import type { BusinessHoursRules, MemberAvailability } from "../src/lib/availability/compute.ts";
import type { CapacityEventType } from "../src/lib/admin/team-capacity.ts";
import type { CapacityPeople } from "../src/lib/admin/team-capacity-load.ts";
import { fillReadings, officeSlot, type FillReadingRow } from "../src/lib/admin/capacity-fill.ts";
import { estimate, pace, walkAdvisorOf, type PaceReading, type PatternCell } from "../src/lib/admin/capacity-pace.ts";
import { fillCellAt, fillPace, PATTERN_LOOKBACK_MS } from "../src/lib/admin/capacity-fill-pace.ts";

const ZONE = "America/New_York";
const MIN = 60_000;
const HALF = 30 * MIN;
const hours: BusinessHoursRules = {
  zone: ZONE,
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })),
  exceptions: [],
};
// The live setting on 2026-10-22.
const ev: CapacityEventType = { duration_min: 20, slot_interval_min: 10, min_notice_min: 5, buffer_before_min: 10, buffer_after_min: 10, daily_cap: null };
const TUE = "2026-10-20";
const WED = "2026-10-21";
const at = (hm: string, iso = TUE) => DateTime.fromISO(`${iso}T${hm}`, { zone: ZONE }).toMillis();
const NINE_TO_FIVE = [2, 3].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 }));
const member = (userId: string): MemberAvailability => ({ userId, timezone: ZONE, rules: NINE_TO_FIVE, busy: [], bookingStartsMs: [], dayCounts: new Map() });
const people = (ids: string[]): CapacityPeople => ({
  roster: ids.map((id) => ({ id, name: id, email: `${id}@x.test` })),
  members: ids.map(member),
  timeOff: new Map(),
  failingEmails: new Set(),
});
const iso = (ms: number) => new Date(ms).toISOString();
/** Stored readings for a day, one per half hour ending at each instant, each taking `taken`. */
const history = (ends: number[], taken: number | null): PaceReading[] => ends.map((t) => ({ read_at: iso(t), prev_read_at: iso(t - HALF), taken }));

const ppl = people(["u1", "u2", "u3"]);
const readAtMs = at("12:00");
const rowsAt = (ms: number, days = [TUE, WED]) =>
  fillReadings({ readAtMs: ms, windowDays: days, bookerDays: days, hours, eventType: ev, people: ppl, last: new Map() }).rows;
const run = (over: { rows?: FillReadingRow[]; history?: Map<string, PaceReading[]>; pattern?: PatternCell[] } = {}) =>
  fillPace({
    readAtMs,
    rows: over.rows ?? rowsAt(readAtMs),
    history: over.history ?? new Map(),
    pattern: over.pattern ?? [],
    people: ppl,
    hours,
    eventType: ev,
    offeredDays: 2,
  });
const rowOf = (rows: FillReadingRow[], day: string) => {
  const r = rows.find((x) => x.day === day);
  if (!r) throw new Error(`no reading for ${day}`);
  return r;
};

// --- a measured pace: the columns are the module's own answer ------------------------------------
{
  // This reading took 9 calls since 11:30; the five before it took 3 each: 24 in 3 hours.
  const rows = rowsAt(readAtMs).map((r) => ({ ...r, prev_read_at: iso(readAtMs - HALF), taken: 9, taken_reason: null }));
  const before = history([at("09:30"), at("10:00"), at("10:30"), at("11:00"), at("11:30")], 3);
  const out = run({ rows, history: new Map([[TUE, before]]) });
  const tue = rowOf(out, TUE);
  const expectPace = pace([...before, { read_at: iso(readAtMs), prev_read_at: iso(readAtMs - HALF), taken: 9 }], readAtMs);
  eq(expectPace.state, "pace", "fixture: six known half hours of 3 calls is a pace");
  eq([tue.pace_state, tue.pace_per_hour], ["pace", 8], "the stored pace is 8 an hour, counting the reading being written (6 without it)");
  eq(tue.pace_back_at, null, "a measured pace has no return time");

  const est = estimate({
    readAtMs,
    advisors: ppl.roster.map((u) => walkAdvisorOf({ member: ppl.members.find((m) => m.userId === u.id)!, timeOff: [], day: DateTime.fromISO(TUE, { zone: ZONE }).startOf("day"), eventType: ev, hours, nowMs: readAtMs }, false)),
    eventType: ev,
    pace: expectPace,
    pattern: [],
    cellAt: (stepMs) => fillCellAt(stepMs, TUE, hours, ev, 2),
  });
  eq(
    [tue.estimate_line_state, tue.estimate_line_at, tue.estimate_pattern_state, tue.estimate_pattern_at, tue.estimate_method, tue.estimate_cells_fallen_back],
    [
      est.line.state,
      est.line.state === "at" ? iso(est.line.atMs) : null,
      est.pattern.state,
      est.pattern.state === "at" ? iso(est.pattern.atMs) : null,
      est.shown,
      est.cellsFallenBack,
    ],
    "both estimates, the method shown and the fallen back cells are stored exactly as estimate() gives them",
  );
  eq(tue.estimate_method, "line", "with no pattern yet the straight line is shown");
  assert(tue.estimate_line_state === "at" || tue.estimate_line_state === "wont-fill", `the straight line walked to an answer (got ${tue.estimate_line_state})`);
  eq(rowOf(out, WED).pace_state, "no-pace-yet", "a day with no stored readings has no pace yet, judged on its own");
}

// --- the last call (#4190): stored from 95%, and only there -----------------------------------------
{
  // Wednesday all but booked: one advisor busy all day, one to 4:30pm, so one call of 32 is left
  // and the day is past 95% at noon Tuesday.
  const full: CapacityPeople = {
    ...people(["v1", "v2"]),
    members: [
      { ...member("v1"), busy: [{ start: at("09:00", WED), end: at("17:00", WED) }] },
      { ...member("v2"), busy: [{ start: at("09:00", WED), end: at("16:30", WED) }] },
    ],
  };
  const rows = fillReadings({ readAtMs, windowDays: [TUE, WED], bookerDays: [TUE, WED], hours, eventType: ev, people: full, last: new Map() }).rows.map((r) => ({ ...r, prev_read_at: iso(readAtMs - HALF), taken: 2, taken_reason: null }));
  const before = history([at("09:30"), at("10:00"), at("10:30"), at("11:00"), at("11:30")], 2);
  const out = fillPace({ readAtMs, rows, history: new Map([[TUE, before], [WED, before]]), pattern: [], people: full, hours, eventType: ev, offeredDays: 2 });
  const wed = rowOf(out, WED);
  eq(wed.estimate_line_state, "already", `fixture: Wednesday is past 95% at noon Tuesday (${wed.open} open of ${wed.capacity})`);
  const last = estimate({
    readAtMs,
    advisors: full.members.map((m) => walkAdvisorOf({ member: m, timeOff: [], day: DateTime.fromISO(WED, { zone: ZONE }).startOf("day"), eventType: ev, hours, nowMs: readAtMs }, false)),
    eventType: ev,
    pace: pace([...before, { read_at: iso(readAtMs), prev_read_at: iso(readAtMs - HALF), taken: 2 }], readAtMs),
    pattern: [],
    cellAt: (stepMs) => fillCellAt(stepMs, WED, hours, ev, 2),
    target: "last-call",
  });
  eq(last.line.state, "at", "fixture: at 4 an hour the last call goes before Wednesday");
  eq(
    [wed.estimate_last_line_state, wed.estimate_last_line_at, wed.estimate_last_pattern_state, wed.estimate_last_pattern_at, wed.estimate_last_method],
    [last.line.state, last.line.state === "at" ? iso(last.line.atMs) : null, last.pattern.state, last.pattern.state === "at" ? iso(last.pattern.atMs) : null, last.shown],
    "a day past 95% stores the last call estimate exactly as estimate() gives it",
  );
  const tue = rowOf(out, TUE);
  eq(
    [tue.estimate_last_line_state, tue.estimate_last_line_at, tue.estimate_last_pattern_state, tue.estimate_last_pattern_at, tue.estimate_last_method],
    [null, null, null, null, null],
    "a day under 95% stores no last call estimate: its card says Full by for 95%",
  );
}

// --- not yet, missed, and not filling --------------------------------------------------------------
{
  const first = rowOf(run(), TUE);
  eq([first.pace_state, first.pace_per_hour, first.pace_back_at], ["no-pace-yet", null, null], "the first reading of a day has no pace yet");
  eq([first.estimate_line_state, first.estimate_pattern_state], ["no-pace", "no-pace"], "and no estimate to walk");

  // Readings reach back to 8:30, but only the 11:00 and 11:30 half hours are known.
  const gappy: PaceReading[] = [
    { read_at: iso(at("09:00")), prev_read_at: iso(at("08:30")), taken: null },
    { read_at: iso(at("10:30")), prev_read_at: iso(at("09:00")), taken: null },
    ...history([at("11:00"), at("11:30")], 2),
  ];
  const rows = rowsAt(readAtMs).map((r) => ({ ...r, prev_read_at: iso(readAtMs - HALF), taken: 2, taken_reason: null }));
  const missed = rowOf(run({ rows, history: new Map([[TUE, gappy]]) }), TUE);
  const expected = pace([...gappy, { read_at: iso(readAtMs), prev_read_at: iso(readAtMs - HALF), taken: 2 }], readAtMs);
  if (expected.state !== "readings-missed") throw new Error(`fixture: expected readings missed, got ${expected.state}`);
  eq([missed.pace_state, missed.pace_back_at], ["readings-missed", iso(expected.backAtMs)], "a gap stores readings missed and the half hour the pace returns");
  eq(missed.pace_per_hour, null, "with no pace number");

  const flat = rowsAt(readAtMs).map((r) => ({ ...r, prev_read_at: iso(readAtMs - HALF), taken: 0, taken_reason: null }));
  const still = rowOf(run({ rows: flat, history: new Map([[TUE, history([at("09:30"), at("10:00"), at("10:30"), at("11:00"), at("11:30")], 0)]]) }), TUE);
  eq([still.pace_state, still.pace_per_hour], ["not-filling", 0], "nothing taken in three hours is not filling, its number kept");
}

// --- a step's cell ------------------------------------------------------------------------------------
{
  const noon = fillCellAt(at("12:00"), WED, hours, ev, 2);
  eq([noon.dayPosition, noon.slotOfDay, noon.weekday], [1, officeSlot(at("12:00"), ZONE).slotOfDay, 2], "Wed at Tuesday noon is the booker's second day, Tuesday's noon half hour");
  const wedMorning = fillCellAt(at("09:00", WED), WED, hours, ev, 2);
  eq(wedMorning.dayPosition, 0, "the same day stepped into Wednesday morning is the booker's first day then");
  eq(wedMorning.weekday, 3, "and Wednesday's weekday");
  const past = fillCellAt(at("09:00", "2026-10-22"), WED, hours, ev, 2);
  eq(past.dayPosition, null, "once the day has gone, it has no position and so no cell");
}

// --- the pattern's window ---------------------------------------------------------------------------
{
  eq(PATTERN_LOOKBACK_MS, 42 * 24 * 3_600_000, "the pattern reads six weeks, enough for a weekday's own cells to reach their floor");
}

// --- a stored reading the pace cannot read throws, never drops out --------------------------------
{
  let threw = false;
  try {
    run({ history: new Map([[TUE, [{ read_at: "not a time", prev_read_at: null, taken: 1 }]]]) });
  } catch {
    threw = true;
  }
  assert(threw, "an unreadable stored instant fails the run rather than quietly changing the pace");
}

finish();

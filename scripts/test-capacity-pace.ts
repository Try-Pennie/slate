// Booking pace on Team capacity (#4103): each day's filling pace, and when it will reach 95% full,
// by the straight line and by the pattern, both from day one.
//
// The rules a wrong answer would hide behind a plausible time:
//  - the pace counts only the KNOWN intervals of the last 3 hours, by how long each one ran, and is
//    never a guess: no pace yet under 3 hours of readings (launch, a new day joining), and readings
//    missed, with when the pace comes back, under 2 known hours of the last 3 after that;
//  - a pace at or under 0 is not filling, a state of its own, never a time;
//  - the walk's shortcut (starts seen now, cut at t plus notice, packed) is the booker's rule: it
//    equals `advisorDay` at nowMs = t, across a clock change too;
//  - the estimate predicts the card's own percent through `dayTotals`, 95 inclusive, so it equals a
//    slow walk that calls `advisorDay` at every step;
//  - a pattern cell is used only with enough samples, a weekday's own cell first, and the pattern is
//    the method shown only when no cell fell back, so "at this pace" is never wrong.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-capacity-pace.ts
import { DateTime } from "luxon";
import { eq, finish } from "./lib/harness.ts";
import type { BusinessHoursRules, MemberAvailability, WorkingRule } from "../src/lib/availability/compute.ts";
import { advisorDay, dayTotals, type AdvisorDayInput, type CapacityEventType, type TimeOffInterval } from "../src/lib/admin/team-capacity.ts";
import {
  estimate,
  pace,
  walkAdvisorAt,
  walkAdvisorOf,
  type CellKey,
  type Estimate,
  type EstimateInput,
  type Pace,
  type PaceReading,
  type PatternCell,
  type WalkAdvisor,
} from "../src/lib/admin/capacity-pace.ts";

const ZONE = "America/New_York";
const MIN = 60_000;
const HOUR = 60 * MIN;
// The office open every day, so the clock change Sunday is a working day.
const hours: BusinessHoursRules = {
  zone: ZONE,
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })),
  exceptions: [],
};
// The live event type: 20 minute calls, a 10 minute grid, a 10 minute gap each side, 5 minutes notice.
const ev: CapacityEventType = { duration_min: 20, slot_interval_min: 10, min_notice_min: 5, buffer_before_min: 10, buffer_after_min: 10, daily_cap: null };

const at = (iso: string, hm: string, zone = ZONE) => DateTime.fromISO(`${iso}T${hm}`, { zone }).toMillis();
const dayOf = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).startOf("day");
const rule = (weekday: number, from: string, to: string): WorkingRule => {
  const m = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  return { weekday, start_minute: m(from), end_minute: m(to) };
};
const member = (userId: string, rules: WorkingRule[], busy: { start: number; end: number }[] = [], timezone = ZONE, dayCounts = new Map<string, number>()): MemberAvailability => ({
  userId,
  timezone,
  rules,
  busy,
  bookingStartsMs: [],
  dayCounts,
});
const inputFor = (m: MemberAvailability, iso: string, nowMs: number, timeOff: TimeOffInterval[] = [], eventType = ev): AdvisorDayInput => ({
  member: m,
  timeOff,
  day: dayOf(iso),
  eventType,
  hours,
  nowMs,
});

// The cell a reading at `ms` is stamped with, as the lane will stamp it: the target day's place
// counted from the office day at `ms` (every test day is open), and the office's half hour.
const cellAtFor = (targetIso: string) => (ms: number): CellKey => {
  const local = DateTime.fromMillis(ms, { zone: ZONE });
  const position = Math.round(dayOf(targetIso).diff(local.startOf("day"), "days").days);
  return { dayPosition: position >= 0 ? position : null, slotOfDay: Math.floor((local.hour * 60 + local.minute) / 30), weekday: local.weekday };
};
const linePace = (perHour: number): Pace => ({ state: perHour > 0 ? "pace" : "not-filling", perHour, knownHours: 3 });
const est = (over: Partial<EstimateInput> & Pick<EstimateInput, "readAtMs" | "advisors">, targetIso: string) =>
  estimate({ eventType: ev, pace: linePace(1), pattern: [], cellAt: cellAtFor(targetIso), ...over });
const atState = (ms: number): Estimate => ({ state: "at", atMs: ms });
const show = (e: Estimate) => (e.state === "at" ? `at ${DateTime.fromMillis(e.atMs, { zone: ZONE }).toISO()}` : e.state);

// --- pace: known intervals of the last 3 hours, per hour --------------------------------------------
{
  const NOW = at("2026-10-20", "12:00");
  const iso = (ms: number) => new Date(ms).toISOString();
  // A reading ending `endMs` that measured the `lenMin` minutes before it.
  const rd = (endMs: number, lenMin: number, taken: number | null): PaceReading => ({ read_at: iso(endMs), prev_read_at: iso(endMs - lenMin * MIN), taken });
  const halfHours = (takens: (number | null)[]) => takens.map((t, i) => rd(NOW - (takens.length - 1 - i) * 30 * MIN, 30, t));

  // Six known half hours: 27 taken in 3 hours. The reading ending exactly 3 hours ago measured
  // the half hour BEFORE the window, so it is left out.
  const six = [rd(NOW - 3 * HOUR, 30, 100), ...halfHours([4, 5, 3, 6, 4, 5])];
  eq(pace(six, NOW), { state: "pace", perHour: 9, knownHours: 3 }, "six known half hours: 27 taken over 3 hours is 9 an hour");
  eq(pace([...six, rd(NOW + 30 * MIN, 30, 100)], NOW), { state: "pace", perHour: 9, knownHours: 3 }, "a reading after now is not counted");

  // Readings going back 3 hours but fewer than 2 of them known: readings were missed, and the
  // pace comes back once half hourly readings would make 2 known hours again.
  eq(pace(halfHours([4, 5, 3, null, null, null]), NOW), { state: "readings-missed", knownHours: 1.5, backAtMs: NOW + 2 * HOUR }, "1.5 known hours, all early: readings missed, back by 2pm as the known ones age out");
  eq(pace(halfHours([null, null, null, 4, 5, 3]), NOW), { state: "readings-missed", knownHours: 1.5, backAtMs: NOW + 30 * MIN }, "1.5 known hours, all recent: back by 12:30pm with one more reading");
  eq(pace(halfHours([4, null, null, null, null, 3]), NOW), { state: "readings-missed", knownHours: 1, backAtMs: NOW + 90 * MIN }, "1 known hour split across the gap: back by 1:30pm");
  eq(pace(halfHours([null, null, null, null, null, null]), NOW), { state: "readings-missed", knownHours: 0, backAtMs: NOW + 2 * HOUR }, "nothing known for 3 hours: back by 2pm, four readings on");
  eq(pace(halfHours([null, null, 4, 5, 3, 4]), NOW), { state: "pace", perHour: 8, knownHours: 2 }, "exactly 2 known hours is a pace: 16 over 2 hours");

  // Fewer than 3 hours of readings in all: launch, and each night a new day joins the cards.
  // No pace yet, even with 2 known hours: the pace shows after 3 hours of readings.
  const first = (ms: number): PaceReading => ({ read_at: iso(ms), prev_read_at: null, taken: null });
  eq(pace([first(NOW)], NOW), { state: "no-pace-yet", knownHours: 0 }, "a first reading alone is no pace yet");
  eq(pace([], NOW), { state: "no-pace-yet", knownHours: 0 }, "no readings is no pace yet");
  eq(pace([first(NOW - 2 * HOUR), ...halfHours([4, 5, 3, 6])], NOW), { state: "no-pace-yet", knownHours: 2 }, "two hours of readings since launch, all known, is still no pace yet");
  eq(pace([first(NOW - 150 * MIN), ...halfHours([4, null, null, 6, 4])], NOW), { state: "no-pace-yet", knownHours: 1.5 }, "two and a half hours of readings with a gap is no pace yet, not readings missed");
  // The boundary: readings reaching back exactly 3 hours.
  eq(pace([first(NOW - 3 * HOUR), ...halfHours([4, 5, 3, 6, 4, 5])], NOW), { state: "pace", perHour: 9, knownHours: 3 }, "three hours of readings since launch, all known, is a pace");
  eq(pace([first(NOW - 3 * HOUR), ...halfHours([4, 5, 3, null, null, null])], NOW), { state: "readings-missed", knownHours: 1.5, backAtMs: NOW + 2 * HOUR }, "three hours of readings since launch with a gap is readings missed");

  // A gap: the lane missed two runs, so one reading measured an hour and a half. It counts for
  // the time it ran, not as one interval.
  eq(pace([rd(NOW - 90 * MIN, 90, 9), rd(NOW - 30 * MIN, 30, null), rd(NOW, 30, 3)], NOW), { state: "pace", perHour: 6, knownHours: 2 }, "an hour and a half reading after a gap counts 1.5 hours: 12 over 2 hours");
  // A reading that began before the window is left out whole, never shared out by guesswork.
  eq(pace([rd(NOW - 2 * HOUR, 90, 50), ...halfHours([2, 2, 2, 2])], NOW), { state: "pace", perHour: 4, knownHours: 2 }, "a reading reaching back past 3 hours is left out");
  eq(pace([rd(NOW - 2 * HOUR, 90, 50), ...halfHours([2, 2, 2])], NOW), { state: "readings-missed", knownHours: 1.5, backAtMs: NOW + 30 * MIN }, "and its hours do not count toward the 2");

  // At or under 0: not filling, with the number kept.
  eq(pace(halfHours([0, 0, 0, 0, 0, 0]), NOW), { state: "not-filling", perHour: 0, knownHours: 3 }, "a pace of exactly 0 is not filling");
  eq(pace(halfHours([-1, 0, 0, 0, 0, 0]), NOW), { state: "not-filling", perHour: -1 / 3, knownHours: 3 }, "more given back than taken is not filling");
  eq(pace(halfHours([-1, 0, 0, 0, 0, 1.5]), NOW), { state: "pace", perHour: 0.5 / 3, knownHours: 3 }, "a small net gain is a pace");
}

// --- the walk's shortcut is the booker's rule: advisorDay at nowMs = t ------------------------------
{
  const holdsAdvisorDay = (label: string, m: MemberAvailability, iso: string, readAtMs: number, toMs: number, timeOff: TimeOffInterval[] = [], eventType = ev) => {
    const walker = walkAdvisorOf(inputFor(m, iso, readAtMs, timeOff, eventType), false);
    let steps = 0, mismatches = 0, first = "";
    for (let t = readAtMs; t <= toMs; t += 10 * MIN) {
      const d = advisorDay(inputFor(m, iso, t, timeOff, eventType));
      const w = walkAdvisorAt(walker, eventType, t);
      steps++;
      if (w.open !== d.open || w.capacity !== d.capacity) {
        mismatches++;
        first ||= `${DateTime.fromMillis(t, { zone: ZONE }).toISO()}: walk ${w.open}/${w.capacity}, advisorDay ${d.open}/${d.capacity}`;
      }
    }
    eq(mismatches === 0 ? "equal" : first, "equal", `${label}: the walk equals advisorDay at every 10 minutes (${steps} instants)`);
  };
  const tue = "2026-10-20";
  // Two windows, four calendar events of awkward lengths, time off reaching past the shift.
  holdsAdvisorDay(
    "a realistic advisor",
    member("a", [rule(2, "09:00", "12:00"), rule(2, "13:00", "18:00")], [
      { start: at(tue, "10:00"), end: at(tue, "10:20") },
      { start: at(tue, "10:40"), end: at(tue, "11:00") },
      { start: at(tue, "14:15"), end: at(tue, "15:05") },
      { start: at(tue, "16:30"), end: at(tue, "16:50") },
    ]),
    tue,
    at("2026-10-19", "18:00"),
    at("2026-10-21", "00:00"),
    [{ startMs: at(tue, "12:30"), endMs: at(tue, "14:00") }],
  );
  // An advisor whose own hours are in another zone: 08:00 to 16:00 in Chicago.
  holdsAdvisorDay(
    "an advisor in Chicago",
    member("b", [rule(2, "08:00", "16:00")], [{ start: at(tue, "11:00"), end: at(tue, "12:10") }], "America/Chicago"),
    tue,
    at(tue, "06:00"),
    at("2026-10-21", "00:00"),
  );
  // A daily cap with calls already booked: open stops at what the cap leaves, capacity at the cap.
  holdsAdvisorDay(
    "an advisor under a daily cap",
    member("c", [rule(2, "09:00", "17:00")], [{ start: at(tue, "09:30"), end: at(tue, "09:50") }], ZONE, new Map([[tue, 2]])),
    tue,
    at(tue, "06:00"),
    at("2026-10-21", "00:00"),
    [],
    { ...ev, daily_cap: 6 },
  );
  // The clocks go back at 2am on Sunday 1 November 2026: a 25 hour night to walk across.
  const sun = "2026-11-01";
  holdsAdvisorDay(
    "across the clocks going back",
    member("d", [rule(7, "09:00", "17:00")], [{ start: at(sun, "11:00"), end: at(sun, "11:40") }]),
    sun,
    at("2026-10-31", "20:00"),
    at("2026-11-02", "00:00"),
  );
}

// --- the estimate ------------------------------------------------------------------------------------
const TUE = "2026-10-20";
const nineToSeven = (weekday = 2) => member("e", [rule(weekday, "09:00", "19:00")]);
const walkerOn = (m: MemberAvailability, iso: string, readAtMs: number, timeOff: TimeOffInterval[] = [], unsynced = false): WalkAdvisor =>
  walkAdvisorOf(inputFor(m, iso, readAtMs, timeOff), unsynced);
{
  // 95 or more now: already, both ways. One call left of 20 is exactly 95. An advisor whose
  // calendar is not syncing has a whole empty day and would pull it down if it were counted.
  const R = at(TUE, "06:00");
  const almost = member("f", [rule(2, "09:00", "19:00")], [{ start: at(TUE, "09:00"), end: at(TUE, "18:30") }]);
  const r = est({ readAtMs: R, advisors: [walkerOn(almost, TUE, R), walkerOn(nineToSeven(), TUE, R, [], true)] }, TUE);
  eq(r, { line: { state: "already" }, pattern: { state: "already" }, shown: "line", cellsFallenBack: 0 }, "a day at 95% now is already there, by both methods");
  const ninety = member("g", [rule(2, "09:00", "19:00")], [{ start: at(TUE, "09:00"), end: at(TUE, "18:00") }]);
  eq(show(est({ readAtMs: R, advisors: [walkerOn(ninety, TUE, R)], pace: linePace(0) }, TUE).line), "wont-fill", "a day at 90% with nothing booking is not already");
}
{
  // The last call (#4190, decision 20): from 95% the card's Full by is when no call is left open.
  // One call left of 20 is 95%, so already for Full by, and taken at 2 an hour it goes at 6:30am.
  const R = at(TUE, "06:00");
  const almost = member("f", [rule(2, "09:00", "19:00")], [{ start: at(TUE, "09:00"), end: at(TUE, "18:30") }]);
  const team = [walkerOn(almost, TUE, R), walkerOn(nineToSeven(), TUE, R, [], true)];
  const last = est({ readAtMs: R, advisors: team, pace: linePace(2), target: "last-call" }, TUE);
  eq(show(last.line), show(atState(at(TUE, "06:30"))), "the last open call is taken at 6:30am at 2 an hour");
  eq(show(last.pattern), show(last.line), "the pattern, every cell fallen back, says the same");
  eq(show(est({ readAtMs: R, advisors: team, pace: linePace(0), target: "last-call" }, TUE).line), "wont-fill", "nothing booking leaves the last call open to the day's last bookable moment");
  const booked = member("f2", [rule(2, "09:00", "19:00")], [{ start: at(TUE, "09:00"), end: at(TUE, "19:00") }]);
  eq(est({ readAtMs: R, advisors: [walkerOn(booked, TUE, R)], target: "last-call" }, TUE).line, { state: "already" }, "no call open now is already there");
  eq(show(est({ readAtMs: R, advisors: team, pace: linePace(2) }, TUE).line), "already", "the default target is still Full by's 95%");
}
{
  // 95 is inclusive and judged by dayTotals' rounding: 20 calls, 19 taken is 95.
  const R = at(TUE, "06:00");
  const team = [walkerOn(nineToSeven(), TUE, R)];
  const fast = est({ readAtMs: R, advisors: team, pace: linePace(19) }, TUE);
  eq(show(fast.line), show(atState(at(TUE, "07:00"))), "19 an hour: 19 of 20 taken by 7am is exactly 95%");
  eq(show(fast.pattern), show(fast.line), "with no pattern every cell falls back, so the pattern says the same");
  eq(fast.cellsFallenBack, 2, "the two cells the walk used both fell back");
  eq(fast.shown, "line", "a walk with any cell fallen back shows the straight line");
  eq(show(est({ readAtMs: R, advisors: team, pace: linePace(18.9) }, TUE).line), show(atState(at(TUE, "07:30"))), "18.9 an hour is 94% at 7am, so 7:30am");
}
{
  // A time on a later day: Wednesday's 20 calls, read Tuesday at 4pm, taken at 2 an hour.
  const R = at(TUE, "16:00");
  const r = est({ readAtMs: R, advisors: [walkerOn(nineToSeven(3), "2026-10-21", R)], pace: linePace(2) }, "2026-10-21");
  eq(show(r.line), show(atState(at("2026-10-21", "01:30"))), "19 taken by 1:30am Wednesday");
}
{
  // The clocks going back: Sunday's 16 calls read Saturday at 10pm, at 2 an hour, take 8 real
  // hours to reach 95%. That is 5am, not the 6am a walk counting wall clock hours would say.
  const R = at("2026-10-31", "22:00");
  const r = est({ readAtMs: R, advisors: [walkerOn(member("h", [rule(7, "09:00", "17:00")]), "2026-11-01", R)], pace: linePace(2) }, "2026-11-01");
  eq(show(r.line), show(atState(DateTime.fromISO("2026-11-01T05:00", { zone: ZONE }).toMillis())), "16 half hour steps across the extra hour land at 5am");
  eq(show(r.line), show(atState(Date.parse("2026-11-01T10:00:00Z"))), "which is 10:00 UTC, eight hours after 02:00 UTC");
}
{
  // Today late in the day: calls passing unbooked move the percent with nobody booking.
  // At 5pm two of four calls are open (a call is booked at 6:30pm); by 6pm none are.
  const R = at(TUE, "17:00");
  const booked = member("i", [rule(2, "09:00", "19:00")], [{ start: at(TUE, "18:30"), end: at(TUE, "18:50") }]);
  const r = est({ readAtMs: R, advisors: [walkerOn(booked, TUE, R)], pace: linePace(0) }, TUE);
  eq(show(r.line), show(atState(at(TUE, "18:00"))), "a pace of 0 still reaches 95% at 6pm as the open calls pass");
  // With nothing booked, the calls pass open and the day never fills: the last step is 6:30pm.
  const empty = est({ readAtMs: R, advisors: [walkerOn(nineToSeven(), TUE, R)], pace: linePace(0.5) }, TUE);
  eq(show(empty.line), "wont-fill", "half a call an hour on an empty evening never reaches 95%");
  eq(show(empty.pattern), "wont-fill", "nor by the pattern, every cell fallen back");
}
{
  // A day nobody works has no percent to reach.
  const R = at(TUE, "06:00");
  const r = est({ readAtMs: R, advisors: [walkerOn(member("j", [rule(3, "09:00", "17:00")]), TUE, R)] }, TUE);
  eq(r, { line: { state: "no-capacity" }, pattern: { state: "no-capacity" }, shown: "line", cellsFallenBack: 0 }, "no capacity is its own state");
}

// --- the pattern: per cell, per weekday, and which method is shown ----------------------------------
{
  const R = at(TUE, "06:00");
  const team = [walkerOn(nineToSeven(), TUE, R)];
  // Cells 13 (6:30am) and 14 (7am) of today: 10 expected in each half hour.
  const cell = (slotOfDay: number, avgTaken: number, samples: number, weekday: number | null = null): PatternCell => ({ dayPosition: 0, slotOfDay, weekday, avgTaken, samples });

  const full = est({ readAtMs: R, advisors: team, pattern: [cell(13, 10, 10), cell(14, 10, 10)] }, TUE);
  eq(show(full.pattern), show(atState(at(TUE, "07:00"))), "two cells of 10 samples: 20 taken by 7am by the pattern");
  eq(full.cellsFallenBack, 0, "no cell fell back");
  eq(full.shown, "pattern", "every cell the walk used came from the pattern, so it is shown");
  eq(show(full.line) !== show(full.pattern), true, `the straight line is still worked out, and differs (${show(full.line)})`);

  const thin = est({ readAtMs: R, advisors: team, pattern: [cell(13, 10, 10), cell(14, 10, 9)] }, TUE);
  eq(show(thin.pattern) !== show(atState(at(TUE, "07:00"))), true, `a cell of 9 samples falls back to the straight line (${show(thin.pattern)})`);
  eq(thin.cellsFallenBack >= 1, true, `and is counted (${thin.cellsFallenBack})`);
  eq(thin.shown, "line", "one fallen back cell shows the straight line");

  // A weekday's own cell takes over at 6 samples, before the all days cell.
  const weekdayOwn = est({ readAtMs: R, advisors: team, pattern: [cell(13, 10, 20), cell(14, 10, 20), cell(13, 1, 6, 2), cell(14, 1, 6, 2)] }, TUE);
  eq(show(weekdayOwn.pattern) !== show(atState(at(TUE, "07:00"))), true, `Tuesday's own cells with 6 samples are used (${show(weekdayOwn.pattern)})`);
  const weekdayThin = est({ readAtMs: R, advisors: team, pattern: [cell(13, 10, 20), cell(14, 10, 20), cell(13, 1, 5, 2), cell(14, 1, 5, 2)] }, TUE);
  eq(show(weekdayThin.pattern), show(atState(at(TUE, "07:00"))), "with 5 samples the all days cells are used");
  eq(weekdayThin.shown, "pattern", "and the pattern is still shown");
  const otherWeekday = est({ readAtMs: R, advisors: team, pattern: [cell(13, 10, 20), cell(14, 10, 20), cell(13, 1, 30, 3), cell(14, 1, 30, 3)] }, TUE);
  eq(show(otherWeekday.pattern), show(atState(at(TUE, "07:00"))), "Wednesday's cells are never used on a Tuesday");

  // No pace (not yet, or readings missed): the straight line has nothing to go on, and a pattern
  // needing it cannot finish. Which of the two it is stays on the pace.
  const noPaces: [string, Pace][] = [
    ["no pace yet", { state: "no-pace-yet", knownHours: 1 }],
    ["readings missed", { state: "readings-missed", knownHours: 1, backAtMs: R + HOUR }],
  ];
  for (const [label, noPace] of noPaces) {
    const patternOnly = est({ readAtMs: R, advisors: team, pace: noPace, pattern: [cell(13, 10, 10), cell(14, 10, 10)] }, TUE);
    eq(patternOnly, { line: { state: "no-pace" }, pattern: atState(at(TUE, "07:00")), shown: "pattern", cellsFallenBack: 0 }, `${label}: a fully covered pattern still gives its time`);
    const patternThin = est({ readAtMs: R, advisors: team, pace: noPace, pattern: [cell(13, 10, 10)] }, TUE);
    eq([show(patternThin.line), show(patternThin.pattern), patternThin.shown, patternThin.cellsFallenBack], ["no-pace", "no-pace", "line", 1], `${label}: a thin cell leaves the pattern with no estimate`);
  }
}
{
  // A start that does not parse throws rather than dropping out of the walk as if it had passed (L50).
  const R = at(TUE, "06:00");
  const good = walkerOn(nineToSeven(), TUE, R);
  for (const [label, broken] of [
    ["an open start", { ...good, openStarts: [...good.openStarts, "not a time"] }],
    ["a capacity start", { ...good, capacityStarts: ["not a time", ...good.capacityStarts] }],
  ] as const) {
    let threw = "";
    try {
      est({ readAtMs: R, advisors: [broken] }, TUE);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    eq(threw.includes("not a time"), true, `${label} that does not parse throws, naming it (${threw || "no throw"})`);
  }
}

// --- the estimate equals a slow walk through advisorDay and dayTotals ------------------------------
{
  // The obviously right way: at every half hour, the booker's own day for every advisor, the
  // page's own totals, less what was expected to be taken.
  const slow = (people: { m: MemberAvailability; timeOff: TimeOffInterval[]; unsynced: boolean }[], iso: string, readAtMs: number, perHour: number): string => {
    const end = dayOf(iso).plus({ days: 1 }).toMillis();
    for (let k = 0, t = readAtMs; t < end; k++, t += 30 * MIN) {
      const team = dayTotals(people.map((p) => ({ unsynced: p.unsynced, days: [advisorDay(inputFor(p.m, iso, t, p.timeOff))] })), 0);
      const open = Math.max(0, team.open - Math.max(0, perHour * k * 0.5));
      const pct = dayTotals([{ unsynced: false, days: [{ open, capacity: team.capacity, out: false }] }], 0).fullPct;
      if (pct !== null && pct >= 95) return k === 0 ? "already" : show(atState(t));
    }
    return "wont-fill";
  };
  const people = [
    { m: member("k1", [rule(2, "09:00", "12:00"), rule(2, "13:00", "18:00")], [{ start: at(TUE, "10:00"), end: at(TUE, "10:20") }, { start: at(TUE, "14:15"), end: at(TUE, "15:05") }]), timeOff: [{ startMs: at(TUE, "16:00"), endMs: at(TUE, "18:00") }], unsynced: false },
    { m: member("k2", [rule(2, "08:00", "16:00")], [{ start: at(TUE, "11:00"), end: at(TUE, "12:10") }], "America/Chicago"), timeOff: [], unsynced: false },
    { m: member("k3", [rule(2, "09:00", "19:00")], [{ start: at(TUE, "09:00"), end: at(TUE, "12:00") }, { start: at(TUE, "17:30"), end: at(TUE, "17:50") }]), timeOff: [], unsynced: false },
    { m: member("k4", [rule(2, "09:00", "19:00")]), timeOff: [], unsynced: true },
    { m: member("k5", [rule(2, "09:00", "17:00")]), timeOff: [{ startMs: at(TUE, "00:00"), endMs: at("2026-10-21", "00:00") }], unsynced: false },
  ];
  for (const [when, readAtMs] of [["Monday 6pm", at("2026-10-19", "18:00")], ["Tuesday 6am", at(TUE, "06:00")], ["Tuesday 11:30am", at(TUE, "11:30")], ["Tuesday 4pm", at(TUE, "16:00")]] as const) {
    for (const perHour of [0, 1.5, 4, 12]) {
      const advisors = people.map((p) => walkerOn(p.m, TUE, readAtMs, p.timeOff, p.unsynced));
      const r = est({ readAtMs, advisors, pace: linePace(perHour) }, TUE);
      eq(show(r.line), slow(people, TUE, readAtMs, perHour), `read ${when} at ${perHour} an hour: the walk equals the slow walk`);
    }
  }
}

finish();

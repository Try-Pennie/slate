// Parsing and validating the business-hours editor's form (#1297).
//
// Run: node --experimental-strip-types scripts/test-business-hours-form.ts
//
// This form sets when Pennie is OPEN, which gates every time every lead is offered,
// so the failure directions matter more than for an ordinary settings field.
//
// Three rules shape everything below:
//
//  1. ALWAYS SEVEN ROWS. `resolveBusinessHours` refuses a week that is not exactly
//     seven weekdays, and a refused week is a booker that offers nothing. A save
//     that could write six rows would take availability down, so the parser emits
//     seven or it emits nothing.
//
//  2. ALL OR NOTHING. One bad day refuses the whole save. Writing the good days and
//     dropping the bad one would leave the org open on a week nobody chose, and the
//     person who typed it would see a success.
//
//  3. AN OPEN DAY'S WINDOW IS REFUSED WHEN UNREADABLE; A CLOSED DAY'S IS REPAIRED.
//     The database requires an ordered window on EVERY row, including closed ones
//     (0098: `end_minute > start_minute` has no is_open exemption), but the resolver
//     deliberately never reads a closed day's window. So a blank time on a closed day
//     must not block someone from closing it, while a blank time on an OPEN day must
//     never quietly become midnight: that is the silent-permissive parse (L50) and it
//     would set hours nobody chose on a surface that decides real bookability.
import {
  parseBusinessHoursForm,
  countBookingsOnWeekdays,
  CLOSED_DAY_FALLBACK,
} from "../src/lib/booking/business-hours-form.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A complete open week, 08:00 to 20:00, as the form posts it. */
function week(over: Record<string, string> = {}): Record<string, string> {
  const f: Record<string, string> = {};
  for (const d of [1, 2, 3, 4, 5, 6, 7]) {
    f[`bh_open_${d}`] = "on";
    f[`bh_start_${d}`] = "08:00";
    f[`bh_end_${d}`] = "20:00";
  }
  return { ...f, ...over };
}

const byDay = (rows: { weekday: number }[]) => new Map(rows.map((r) => [r.weekday, r]));

// --- the happy week ----------------------------------------------------------------
{
  const res = parseBusinessHoursForm(week());
  eq(res.errors.length, 0, "a complete valid week parses with no errors");
  eq(res.rows.length, 7, "and always yields exactly seven rows, one per weekday");
  eq(
    res.rows.map((r) => r.weekday).join(","),
    "1,2,3,4,5,6,7",
    "the rows are the seven weekdays in order, so the stored week can never be partial",
  );
  assert(
    res.rows.every((r) => r.is_open && r.start_minute === 480 && r.end_minute === 1200),
    "08:00 to 20:00 is stored as minutes from local midnight",
  );
}

// --- closing a day -----------------------------------------------------------------
{
  // An unchecked box posts nothing at all, which is how a day is closed.
  const f = week();
  delete f.bh_open_7;
  const res = parseBusinessHoursForm(f);
  eq(res.errors.length, 0, "closing a day is a valid save");
  eq(byDay(res.rows).get(7)!.is_open, false, "the unchecked day is stored closed");
  eq(byDay(res.rows).get(1)!.is_open, true, "and the others are untouched");

  // Its window is KEPT, so re-opening the day restores the hours it had rather than
  // silently coming back as something else.
  const sunday = byDay(res.rows).get(7)!;
  eq(sunday.start_minute, 480, "a closed day keeps its start, so re-opening restores it");
  eq(sunday.end_minute, 1200, "a closed day keeps its end too");
}

// --- an all-closed week is legal, and is the only way to shut entirely ---------------
{
  const f = week();
  for (const d of [1, 2, 3, 4, 5, 6, 7]) delete f[`bh_open_${d}`];
  const res = parseBusinessHoursForm(f);
  eq(res.errors.length, 0, "closing every day is a legitimate stored answer, not an error");
  eq(res.rows.length, 7, "and still writes seven rows");
  assert(res.rows.every((r) => !r.is_open), "every day is stored closed");
}

// --- an OPEN day with an unreadable window is REFUSED, never defaulted ---------------
for (const bad of ["", "   ", "nonsense", "25:00", "12:60", "8", "08:0"]) {
  const res = parseBusinessHoursForm(week({ bh_start_3: bad }));
  assert(
    res.errors.length > 0,
    `an open day with start ${JSON.stringify(bad)} is refused rather than parsed`,
  );
  eq(res.rows.length, 0, `and ${JSON.stringify(bad)} writes nothing at all`);
  assert(
    res.errors.some((e) => /wednesday/i.test(e)),
    `the error for ${JSON.stringify(bad)} names the day, so it is findable in a seven-day form`,
  );
}

// The silent-permissive parse this guards against: 00:00 is a VALID time, so a
// parser that mapped junk to zero would open the org at midnight and report success.
{
  const res = parseBusinessHoursForm(week({ bh_start_3: "" }));
  assert(
    !res.rows.some((r) => r.start_minute === 0),
    "an unreadable start never lands on midnight, which would read as a deliberate choice",
  );
}

// --- an open day whose window is inverted or empty is refused ------------------------
{
  const inverted = parseBusinessHoursForm(week({ bh_start_2: "18:00", bh_end_2: "09:00" }));
  assert(inverted.errors.length > 0, "an open day ending before it starts is refused");
  assert(
    inverted.errors.some((e) => /tuesday/i.test(e)),
    "and the inverted-window error names the day",
  );

  const empty = parseBusinessHoursForm(week({ bh_start_2: "09:00", bh_end_2: "09:00" }));
  assert(
    empty.errors.length > 0,
    "an open day that starts and ends at the same minute is refused, since it offers nothing",
  );
}

// --- the day's bounds ---------------------------------------------------------------
{
  eq(
    parseBusinessHoursForm(week({ bh_start_1: "00:00", bh_end_1: "23:45" })).errors.length,
    0,
    "a full day from midnight to 23:45 is allowed",
  );
  // The database allows 1440 (midnight at the END of the day) but not as a start.
  const res = parseBusinessHoursForm(week({ bh_start_1: "24:00" }));
  assert(res.errors.length > 0, "24:00 is not a valid START, matching the database's check");
}

// --- a CLOSED day's unreadable window is repaired, not refused ------------------------
{
  // The window is meaningless on a closed day (the resolver never reads it), but the
  // database still demands an ordered pair. Refusing to close Sunday because a hidden
  // time field came back blank would block a legitimate change for no reason.
  const f = week({ bh_start_7: "", bh_end_7: "" });
  delete f.bh_open_7;
  const res = parseBusinessHoursForm(f);
  eq(res.errors.length, 0, "a closed day with a blank window still saves");
  const sunday = byDay(res.rows).get(7)!;
  eq(sunday.start_minute, CLOSED_DAY_FALLBACK.start_minute, "its window falls back to the default");
  eq(sunday.end_minute, CLOSED_DAY_FALLBACK.end_minute, "with an ordered pair the database accepts");
  assert(
    sunday.end_minute > sunday.start_minute,
    "the repaired window satisfies the database's ordering check on every row",
  );
}

// --- several bad days report several errors, and still write nothing -----------------
{
  const res = parseBusinessHoursForm(
    week({ bh_start_1: "", bh_start_2: "18:00", bh_end_2: "09:00" }),
  );
  assert(res.errors.length >= 2, "each bad day gets its own message rather than only the first");
  eq(res.rows.length, 0, "and one bad day anywhere refuses the WHOLE week, never a partial save");
}

// --- which days are being newly closed, for the pre-save warning ----------------------
{
  // The editor warns before closing a day that already holds appointments, so it has
  // to know which days are CHANGING to closed, not merely which are closed now.
  const f = week();
  delete f.bh_open_6;
  delete f.bh_open_7;
  const res = parseBusinessHoursForm(f, {
    currentlyOpen: [1, 2, 3, 4, 5, 6], // Sunday was already closed
  });
  eq(
    res.newlyClosed.join(","),
    "6",
    "only a day going from open to closed is newly closed; one already shut is not re-warned",
  );
}
{
  const res = parseBusinessHoursForm(week(), { currentlyOpen: [1, 2, 3, 4, 5] });
  eq(res.newlyClosed.length, 0, "opening days closes nothing, so there is nothing to warn about");
}

// --- counting the appointments a closure would strand ---------------------------------
//
// The editor warns before closing a day that already holds appointments. The count has
// to be taken in the ORG's zone, because a booking's stored instant lands on a
// different weekday depending on the clock you read it with, and warning about the
// wrong day is worse than not warning.
{
  const ZONE = "America/New_York";
  // 2026-06-09T01:00Z is Monday 21:00 in New York, NOT Tuesday. Reading it as UTC
  // would file it under Tuesday and warn about closing the wrong day.
  const lateMonday = "2026-06-09T01:00:00.000Z";
  const midMonday = "2026-06-08T16:00:00.000Z"; // Monday 12:00 New York
  const tuesday = "2026-06-09T16:00:00.000Z"; // Tuesday 12:00 New York

  eq(
    countBookingsOnWeekdays([lateMonday, midMonday, tuesday], ZONE, [1]),
    2,
    "a booking late on Monday evening counts against MONDAY in the org's zone, not the next UTC day",
  );
  eq(
    countBookingsOnWeekdays([lateMonday, midMonday, tuesday], ZONE, [2]),
    1,
    "and Tuesday counts only the Tuesday booking",
  );
  eq(
    countBookingsOnWeekdays([lateMonday, midMonday, tuesday], ZONE, []),
    0,
    "closing no days strands nothing",
  );
  eq(
    countBookingsOnWeekdays([], ZONE, [1, 2, 3]),
    0,
    "no bookings means nothing to warn about",
  );

  // An unreadable instant must not be silently skipped: it is a booking we cannot
  // place, and under-counting here means someone closes a day believing it is empty.
  eq(
    countBookingsOnWeekdays(["not-a-date", midMonday], ZONE, [1]),
    2,
    "an unreadable booking instant counts toward the warning rather than vanishing from it",
  );
}

finish();

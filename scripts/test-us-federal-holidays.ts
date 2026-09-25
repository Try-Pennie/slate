// The US federal holiday calendar the readiness gate checks business hours against
// (#2767). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-us-federal-holidays.ts
//
// Pinned against dates read off the OPM published calendar rather than against the
// rules that produce them (L638), so a wrong rule cannot agree with itself.
import {
  usFederalHolidays,
  holidayDatesToDecide,
  uncoveredHolidays,
} from "../src/lib/booking/us-federal-holidays.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- 2026 and 2027, as OPM publishes them ------------------------------------------
{
  const y2026 = usFederalHolidays(2026).map((h) => `${h.date} ${h.name}`);
  eq(
    y2026,
    [
      "2026-01-01 New Year's Day",
      "2026-01-19 Martin Luther King Jr. Day",
      "2026-02-16 Washington's Birthday",
      "2026-05-25 Memorial Day",
      "2026-06-19 Juneteenth",
      "2026-07-04 Independence Day",
      "2026-09-07 Labor Day",
      "2026-10-12 Columbus Day",
      "2026-11-11 Veterans Day",
      "2026-11-26 Thanksgiving Day",
      "2026-12-25 Christmas Day",
    ],
    "the 2026 calendar, Labor Day on 2026-09-07 among them",
  );
  const y2027 = usFederalHolidays(2027).map((h) => h.date);
  eq(
    y2027,
    ["2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-19", "2027-07-04", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"],
    "the 2027 calendar",
  );
}

// --- a weekend holiday is also decided on the weekday it is observed ------------------
{
  // 2026-07-04 is a Saturday, observed Friday 2026-07-03. 2027-07-04 is a Sunday,
  // observed Monday 2027-07-05. The org is open on Saturdays, so both days matter.
  const d2026 = holidayDatesToDecide("2026-07-01", 10).map((h) => `${h.date} ${h.name}`);
  eq(d2026, ["2026-07-03 Independence Day (observed)", "2026-07-04 Independence Day"], "a Saturday holiday brings its Friday");
  const d2027 = holidayDatesToDecide("2027-07-01", 10).map((h) => h.date);
  eq(d2027, ["2027-07-04", "2027-07-05"], "a Sunday holiday brings its Monday");
}

// --- the window crosses a year and is inclusive of today --------------------------------
{
  const d = holidayDatesToDecide("2026-12-25", 30).map((h) => h.date);
  eq(d, ["2026-12-25", "2027-01-01", "2027-01-18"], "today counts, and January is reached from December");
  eq(holidayDatesToDecide("2026-12-26", 5).length, 0, "a window holding no holiday holds none");
}

// --- coverage: an exception on the date either way, or a weekday the org never opens --------
{
  const open = [1, 2, 3, 4, 5, 6]; // Monday to Saturday, as the org is stored today
  const uncovered = uncoveredHolidays({
    todayIso: "2026-09-25",
    windowDays: 90,
    openWeekdays: open,
    exceptionDates: ["2026-11-26"],
  }).map((h) => h.date);
  eq(uncovered, ["2026-10-12", "2026-11-11"], "Columbus and Veterans Day are undecided, Thanksgiving is closed");

  const decided = uncoveredHolidays({
    todayIso: "2026-09-25",
    windowDays: 90,
    openWeekdays: open,
    // An OPEN exception is a decision too: somebody looked at the day and kept it.
    exceptionDates: ["2026-10-12", "2026-11-11", "2026-11-26"],
  });
  eq(decided.length, 0, "an exception on the date, open or closed, is a decision");

  const sunday = uncoveredHolidays({
    todayIso: "2027-07-01",
    windowDays: 10,
    openWeekdays: open,
    exceptionDates: [],
  }).map((h) => h.date);
  eq(sunday, ["2027-07-05"], "a Sunday holiday the org never opens on is covered, its observed Monday is not");

  // The Labor Day replay (#2738): with no exception that day it is the finding.
  const labor = uncoveredHolidays({ todayIso: "2026-09-01", windowDays: 10, openWeekdays: open, exceptionDates: [] });
  assert(labor.some((h) => h.date === "2026-09-07" && h.name === "Labor Day"), "Labor Day 2026 with no exception is uncovered");
}

finish();

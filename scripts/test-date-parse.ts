// Tests for the date field's parsers (segmented parts + quarter-hour rounding).
// Run: node --experimental-strip-types scripts/test-date-parse.ts
import { DateTime } from "luxon";
import {
  dateFromParts,
  formatLongDate,
  roundDownToQuarterHour,
  roundUpToQuarterHour,
} from "../src/lib/date/parse.ts";
import { assert, finish } from "./lib/harness.ts";

// dateFromParts: segmented MM/DD/YYYY entry.
assert(dateFromParts("03", "14", "2027")?.toISODate() === "2027-03-14", "parts 03/14/2027");
assert(dateFromParts("3", "14", "2027")?.toISODate() === "2027-03-14", "parts tolerate 1-digit month");
assert(dateFromParts("12", "31", "2028")?.toISODate() === "2028-12-31", "parts 12/31/2028");
// Invalid combinations return null (never a bogus date).
for (const [m, d, y] of [["13", "01", "2027"], ["02", "30", "2026"], ["00", "10", "2027"], ["06", "00", "2027"]]) {
  assert(dateFromParts(m, d, y) === null, `parts ${m}/${d}/${y} -> null`);
}
// Incomplete segments (year not yet 4 digits) return null.
assert(dateFromParts("06", "20", "20") === null, "incomplete year -> null");
assert(dateFromParts("", "", "") === null, "empty parts -> null");

// roundDownToQuarterHour: snap times down to :00/:15/:30/:45.
const roundCases: [string, string][] = [
  ["09:00", "09:00"],
  ["09:01", "09:00"],
  ["09:14", "09:00"],
  ["09:15", "09:15"],
  ["09:16", "09:15"],
  ["09:29", "09:15"],
  ["09:44", "09:30"],
  ["09:45", "09:45"],
  ["09:59", "09:45"],
  ["00:07", "00:00"],
  ["23:59", "23:45"],
  ["9:05", "09:00"],
];
for (const [input, want] of roundCases) {
  assert(roundDownToQuarterHour(input) === want, `round ${input} -> ${want} (got ${roundDownToQuarterHour(input)})`);
}
// Malformed / empty stays untouched.
for (const passthrough of ["", "nope", "9", "25:00"]) {
  assert(roundDownToQuarterHour(passthrough) === passthrough, `round-down leaves "${passthrough}" unchanged`);
}

// roundUpToQuarterHour: END times snap UP to :00/:15/:30/:45.
const roundUpCases: [string, string][] = [
  ["17:00", "17:00"],
  ["17:01", "17:15"],
  ["17:14", "17:15"],
  ["17:15", "17:15"],
  ["17:16", "17:30"],
  ["17:45", "17:45"],
  ["17:46", "18:00"],
  ["00:00", "00:00"],
  ["23:46", "23:45"], // clamp: no same-day quarter above 23:45
  ["23:50", "23:45"],
];
for (const [input, want] of roundUpCases) {
  assert(roundUpToQuarterHour(input) === want, `round-up ${input} -> ${want} (got ${roundUpToQuarterHour(input)})`);
}
for (const passthrough of ["", "nope", "25:00"]) {
  assert(roundUpToQuarterHour(passthrough) === passthrough, `round-up leaves "${passthrough}" unchanged`);
}

// formatLongDate: THE long date spelling, US order, for every surface (#2221).
//
// A January date is the case that tells the two orders apart by more than a
// comma, since "1 January" and "January 1" carry the same words, so it is the
// one Dan reported and the one pinned here.
{
  const nyd = DateTime.fromISO("2027-01-01");
  assert(
    formatLongDate(nyd, { year: true }) === "Friday, January 1, 2027",
    `with a year, month before day (got ${formatLongDate(nyd, { year: true })})`,
  );
  assert(
    formatLongDate(nyd) === "Friday, January 1",
    `without a year, month before day (got ${formatLongDate(nyd)})`,
  );
  assert(formatLongDate(nyd, { year: false }) === "Friday, January 1", "year: false is the default");

  // A two digit day, so the day number is never zero padded into "January 01".
  const teen = DateTime.fromISO("2026-08-17");
  assert(formatLongDate(teen, { year: true }) === "Monday, August 17, 2026", "a two digit day");
  assert(formatLongDate(teen) === "Monday, August 17", "a two digit day, no year");

  // Null rather than a plausible looking date, for the same reason
  // formatClockTime answers null: a fallback would put a real looking date on
  // screen for a value nobody chose (L67).
  assert(formatLongDate(DateTime.invalid("nope")) === null, "an invalid DateTime answers null");
  assert(
    formatLongDate(DateTime.invalid("nope"), { year: true }) === null,
    "an invalid DateTime answers null with a year too",
  );

  // The LOCALE is pinned, not inherited. `ManageBooking` built this with
  // `Intl.DateTimeFormat("en-US", ...)`, which names the locale; Luxon's
  // `toFormat` follows the DateTime's own locale, which defaults to the machine's.
  // Folding the two together without pinning would make the words on a lead's
  // confirmation screen depend on the runtime's locale, and the test would still
  // pass on every machine that happens to be English (L504).
  assert(
    formatLongDate(nyd.setLocale("fr"), { year: true }) === "Friday, January 1, 2027",
    `the locale is pinned, not inherited (got ${formatLongDate(nyd.setLocale("fr"), { year: true })})`,
  );
  assert(
    formatLongDate(nyd.setLocale("de"), { year: false }) === "Friday, January 1",
    "pinned without a year too",
  );

  // 23:30 on New Year's Eve in New York is already the 2nd in Tokyo, so the two
  // zones answer different DAYS and this cannot pass by accident.
  const instant = "2027-01-01T23:30:00-05:00";
  assert(
    formatLongDate(DateTime.fromISO(instant, { zone: "Asia/Tokyo" }), { year: true }) ===
      "Saturday, January 2, 2027",
    "renders in the DateTime's own zone",
  );
  assert(
    formatLongDate(DateTime.fromISO(instant, { zone: "America/New_York" }), { year: true }) ===
      "Friday, January 1, 2027",
    "the same instant in another zone is another day, so the zone really decides",
  );
}

finish();

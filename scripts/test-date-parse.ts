// Tests for the date field's parsers (segmented parts + quarter-hour rounding).
// Run: node --experimental-strip-types scripts/test-date-parse.ts
import {
  dateFromParts,
  roundDownToQuarterHour,
  roundUpToQuarterHour,
} from "../src/lib/date/parse.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

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

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

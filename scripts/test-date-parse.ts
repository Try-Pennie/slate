// Tests for the date field's parsers (paste free-text + segmented parts).
// Run: node --experimental-strip-types scripts/test-date-parse.ts
import {
  parseTypedDate,
  dateFromParts,
  roundDownToQuarterHour,
} from "../src/lib/date/parse.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

// Each accepted format resolves to the same day (ISO yyyy-MM-dd).
const accepts: [string, string][] = [
  ["3/14/2027", "2027-03-14"],
  ["03/14/2027", "2027-03-14"],
  ["3-14-2027", "2027-03-14"],
  ["2027-03-14", "2027-03-14"],
  ["Jun 20 2026", "2026-06-20"],
  ["Jun 20, 2026", "2026-06-20"],
  ["June 20 2026", "2026-06-20"],
  ["June 20, 2026", "2026-06-20"],
  ["6/20/26", "2026-06-20"],
  // A bare 4-digit year is valid ISO (resolves to Jan 1 of that year).
  ["2027", "2027-01-01"],
];
for (const [input, iso] of accepts) {
  const d = parseTypedDate(input);
  assert(d?.toISODate() === iso, `"${input}" -> ${iso} (got ${d?.toISODate() ?? "null"})`);
  assert(
    d?.hour === 0 && d?.minute === 0,
    `"${input}" is normalized to start of day`,
  );
}

// Unparseable / empty inputs return null (never a bogus date).
for (const bad of ["", "   ", "not a date", "13/40/2027", "abc/def"]) {
  assert(parseTypedDate(bad) === null, `"${bad}" -> null`);
}

// Whitespace is tolerated around a valid value.
assert(
  parseTypedDate("  3/14/2027  ")?.toISODate() === "2027-03-14",
  "surrounding whitespace is trimmed",
);

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
  assert(roundDownToQuarterHour(passthrough) === passthrough, `round leaves "${passthrough}" unchanged`);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

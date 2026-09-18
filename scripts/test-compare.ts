// #2561: one string comparator, not five copies.
//
// `a < b ? -1 : a > b ? 1 : 0` was written out at five sort sites, and reversed
// by hand at two of them. A hand reversal is the half that goes wrong silently:
// a descending sort written as an ascending one with the arms swapped reads the
// same in review whichever way round it is, and the only symptom is a list in
// the wrong order on a screen nobody diffs. So both directions live in one place
// and are pinned here, including the property that makes one the inverse of the
// other.
//
// Run: node --experimental-strip-types scripts/test-compare.ts
import { compareStrings, compareStringsDesc } from "../src/lib/compare.ts";
import { eq, assert, finish } from "./lib/harness.ts";

// Ascending: the three outcomes, each produced rather than reasoned about.
eq(compareStrings("a", "b"), -1, "ascending: a before b");
eq(compareStrings("b", "a"), 1, "ascending: b after a");
eq(compareStrings("a", "a"), 0, "ascending: equal strings tie");

// Descending: the same three, the other way up.
eq(compareStringsDesc("a", "b"), 1, "descending: a after b");
eq(compareStringsDesc("b", "a"), -1, "descending: b before a");
eq(compareStringsDesc("a", "a"), 0, "descending: equal strings tie");

// The inverse property, over every ordered pair of a set holding the shapes the
// real call sites sort: bucket codes, uuids and ISO timestamps. This is what a
// hand reversal at one site cannot be checked against, because there is nothing
// to compare it to.
const SAMPLES = [
  "411",
  "412",
  "1104",
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
  "2026-09-18T10:00:00+00:00",
  "2026-09-18T09:00:00+00:00",
  "",
];
for (const a of SAMPLES) {
  for (const b of SAMPLES) {
    eq(
      compareStringsDesc(a, b),
      -compareStrings(a, b),
      `descending is the exact inverse of ascending for ${JSON.stringify([a, b])}`,
    );
  }
}

// The sorts the call sites actually perform, asserted on the ORDER rather than
// on the comparator's return value: a comparator can be right about one pair and
// still be handed to `sort` the wrong way round.
eq(
  [...SAMPLES].sort(compareStrings).join("|"),
  ["", "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", "1104", "2026-09-18T09:00:00+00:00", "2026-09-18T10:00:00+00:00", "411", "412"].join("|"),
  "ascending sort orders lexicographically",
);
eq(
  [...SAMPLES].sort(compareStringsDesc).join("|"),
  [...SAMPLES].sort(compareStrings).reverse().join("|"),
  "descending sort is the ascending sort reversed",
);

// ISO timestamps in a fixed offset form sort lexicographically, which is the
// property `erasure-worklist-load.ts` and `booking/search.ts` rest on: newest
// first with no Date.parse anywhere near it (the NaN class scripts/test-date-parse-guard.ts watches).
const stamps = ["2026-09-17T23:59:59+00:00", "2026-09-18T00:00:00+00:00", "2026-09-18T00:00:01+00:00"];
eq(
  [...stamps].sort(compareStringsDesc)[0],
  "2026-09-18T00:00:01+00:00",
  "newest ISO stamp sorts first under the descending comparator",
);

// A comparator must be a pure function of its two arguments, so a sort can call
// it in any order any number of times. The one way this class of helper breaks
// is by closing over state, which shows as a second identical call disagreeing.
assert(
  compareStrings("a", "b") === compareStrings("a", "b") &&
    compareStringsDesc("a", "b") === compareStringsDesc("a", "b"),
  "both comparators answer the same on a repeat call",
);

finish();

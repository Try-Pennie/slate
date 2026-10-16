// #3801: the pure half of the condition repeat rule. What counts as a change, what a
// message's own lines reduce to when a send site names no subjects, the count band,
// and the reminder's wording. The dispatcher half is driven end to end, on a pinned
// clock, by src/lib/notify/daily-repeat.test.ts. The reminder's house style (no
// dashes, no emoji) is held by the alert preview guard, which renders it.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-repeat-policy.ts
import {
  doublingBand,
  formatConditionAge,
  formatReminder,
  normalizeSignatureLine,
  repeatChange,
  signatureSubjects,
  subjectsFor,
} from "../src/lib/notify/repeat-policy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- a number is never a subject -------------------------------------------------
const same = (a: string, b: string, why: string) => eq(normalizeSignatureLine(a), normalizeSignatureLine(b), why);
same(
  "The booking smoke canary has not run for 515 minutes, so the check is not running.",
  "The booking smoke canary has not run for 575 minutes, so the check is not running.",
  "a growing duration reads as the same line",
);
same("3 appointments could not be moved", "5 appointments could not be moved", "a count reads alike");
same("1 appointment could not be moved", "2 appointments could not be moved", "and so does crossing one");
same("1 of 97 bookable agent has a calendar", "2 of 97 bookable agents have a calendar", "agreement after a count");
same("last ok just now", "last ok 4 minutes ago", "a relative age reads alike");
same(
  "See https://github.com/Try-Pennie/slate/actions/runs/123",
  "See https://github.com/Try-Pennie/slate/actions/runs/456",
  "a run link reads alike",
);
same("availability read took 4210ms", "availability read took 4,380ms", "a latency reads alike");
assert(
  normalizeSignatureLine("a@x.com is failing") !== normalizeSignatureLine("b@x.com is failing"),
  "a different name is a different line",
);
eq(normalizeSignatureLine("the class is"), "the class is", "a word ending in ss after nothing is untouched");

// --- signatures --------------------------------------------------------------------
eq(signatureSubjects("one\n\n  one \ntwo"), ["one", "two"], "lines dedupe and blanks drop");
eq(subjectsFor({ subjects: [" b ", "a", "a", ""] }, "ignored"), ["a", "b"], "explicit subjects are trimmed, deduped and sorted");
eq(subjectsFor({ subjects: [] }, "anything at all"), [], "an explicit empty list is kept, not replaced by the text");
eq(subjectsFor(undefined, "x is failing"), ["x is failing"], "no subjects falls back to the message's lines");

// --- what counts as a change -------------------------------------------------------
eq(repeatChange({ subjects: null, band: null }, [], null), "unrecorded", "a row from before the rule is a change");
eq(repeatChange({ subjects: ["a"], band: null }, ["a", "b"], null), "new-subject", "a new subject is a change");
eq(repeatChange({ subjects: ["a", "b"], band: null }, ["a"], null), null, "a subject leaving is not");
eq(repeatChange({ subjects: ["a"], band: 1 }, ["a"], 2), "worse-band", "a worse band is a change");
eq(repeatChange({ subjects: ["a"], band: 2 }, ["a"], 1), null, "a better band is not");
eq(repeatChange({ subjects: ["a"], band: 2 }, ["a"], 2), null, "the same band is not");
eq(repeatChange({ subjects: ["a"], band: null }, ["a"], 3), null, "a band where none was recorded is not");

// --- the band ----------------------------------------------------------------------
eq([0, 1, 2, 3, 4, 7, 8, 15, 16].map(doublingBand), [0, 0, 1, 1, 2, 2, 3, 3, 4], "one band per doubling");
eq(doublingBand(Number.NaN), 0, "an unreadable count is the lowest band, never a change");

// --- the reminder ------------------------------------------------------------------
eq(formatConditionAge(24 * 3_600_000), "24 hours", "a day reads in hours");
eq(formatConditionAge(50 * 3_600_000), "2 days", "two days and more read in days");
eq(formatConditionAge(1 * 60_000), "1 minute", "singular minute");
const r = formatReminder("3 appointments could not be moved.", { sinceMs: 0, atLeast: false }, 26 * 3_600_000);
assert(r.startsWith("Reminder: still true after 26 hours"), `the reminder says so and how long (got ${r})`);
assert(r.endsWith("\n3 appointments could not be moved."), "and carries the message beneath");
const floor = formatReminder("x", { sinceMs: 0, atLeast: true }, 24 * 3_600_000);
assert(floor.startsWith("Reminder: still true after at least 24 hours"), "an unknown start is a floor, said as one");

finish();

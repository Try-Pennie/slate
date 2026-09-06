// #1961: the clock on the erasure worklist.
//
// An erasure request carries a statutory deadline, so "what is outstanding and
// how long has it been outstanding" is the whole reason this queue is kept when
// its destructive controls go. Before this the only date on a row was a
// timestamp, and every reader did the subtraction themselves toward a number
// nobody had written down.
//
// The uncomfortable part is what is DELIBERATELY not shown. Pennie's stated
// position is 45 days from the person's REQUEST, and the only date the trail
// holds is when the Supabase half ran, which is necessarily later. A due date
// computed from this side would fall AFTER the real one, which is the single
// direction a compliance clock must never be wrong in, so none is rendered and
// the shortfall is named instead (L589, L11).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-erasure-clock.ts
import {
  ERASURE_RESPONSE_DAYS,
  entryAgeDays,
  oldestOutstandingDays,
  summarizeWorklist,
  worklistOrder,
  type ErasureWorklistEntry,
} from "../src/lib/snowflake/erasure-worklist.ts";
import {
  deadlineNote,
  entryAgeText,
  worklistHeadline,
} from "../src/lib/snowflake/erasure-worklist-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-09-06T12:00:00+00:00");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const entry = (over: Partial<ErasureWorklistEntry> = {}): ErasureWorklistEntry => ({
  auditId: "a1",
  createdAt: daysAgo(1),
  emailSha256: null,
  bookingIds: ["bk1"],
  residuals: [{ table: "bookings", residual: 0 }],
  unmeasuredReason: null,
  ...over,
});
const outstanding = (id: string, days: number) =>
  entry({ auditId: id, createdAt: daysAgo(days), residuals: [{ table: "bookings", residual: 3 }] });
const clean = (id: string, days: number) => entry({ auditId: id, createdAt: daysAgo(days) });
const unknown = (id: string, days: number) =>
  entry({ auditId: id, createdAt: daysAgo(days), residuals: null, unmeasuredReason: "no answer" });

// --------------------------------------------------------------------- the age

{
  eq(entryAgeDays(daysAgo(12), NOW), 12, "whole days elapsed");
  eq(entryAgeDays(daysAgo(0), NOW), 0, "today is zero days, not one");
  // A stamp arriving from the future (clock skew between the database and the
  // renderer) is clamped rather than rendered as a negative age.
  eq(entryAgeDays(new Date(NOW + 60_000).toISOString(), NOW), 0, "a future stamp is not negative");
}

// AN UNREADABLE STAMP IS NULL, NEVER ZERO. Zero renders as "erased here today",
// which is the reassuring reading of something nobody measured (L50).
{
  eq(entryAgeDays("not a date", NOW), null, "an unreadable stamp yields no number");
  eq(entryAgeDays("", NOW), null, "nor does an empty one");
  const text = entryAgeText(null);
  assert(/cannot read/.test(text), "and the row says the date could not be read");
  assert(!/today/.test(text), "rather than the sentence for a fresh entry");
  assert(!/NaN|null|undefined/.test(text), "and leaks nothing");
}

{
  assert(/today/.test(entryAgeText(0)), "a same day entry says today");
  eq(entryAgeText(1), "Erased here 1 day ago.", "one day is singular");
  eq(entryAgeText(12), "Erased here 12 days ago.", "and more than one is plural");
}

// ----------------------------------------------------------------- the ordering

// OUTSTANDING FIRST, OLDEST FIRST INSIDE IT. The entry that has waited longest
// is the one closest to a deadline, and a list rendered in whatever order the
// store returned puts it anywhere (L343).
{
  // The ids are chosen to sort the OPPOSITE way from the ages, so an ordering
  // that fell back to the id would produce a DIFFERENT answer. With ids that
  // happened to agree with the ages this assertion passes with the age rule
  // removed entirely, which is a fixture shaped to make the rule appear to fire.
  const rows = [clean("c", 40), unknown("u", 5), outstanding("a-young", 2), outstanding("z-old", 30)];
  eq(
    worklistOrder(rows, NOW).map((e) => e.auditId),
    ["z-old", "a-young", "u", "c"],
    "outstanding first, oldest first, then unmeasured, then clean",
  );
  assert(
    "z-old".localeCompare("a-young") > 0,
    "and the ids really do sort the other way, so the age is what put the old one first",
  );
}

// AN UNREADABLE STAMP SORTS TO THE TOP of its group. It cannot be shown to be
// young, and the safe reading of an unknown age on a compliance clock is the
// alarming one.
{
  const rows = [outstanding("known", 3), entry({ auditId: "broken", createdAt: "nope", residuals: [{ table: "bookings", residual: 1 }] })];
  eq(worklistOrder(rows, NOW).map((e) => e.auditId), ["broken", "known"], "an unreadable age leads");
}

{
  const rows = [outstanding("b", 5), outstanding("a", 5)];
  eq(worklistOrder(rows, NOW).map((e) => e.auditId), ["a", "b"], "an exact tie is broken stably by id");
  eq(worklistOrder(rows, NOW).length, rows.length, "and nothing is dropped");
  eq(rows.map((e) => e.auditId), ["b", "a"], "the input is not mutated");
}

// ------------------------------------------------------------------ the summary

{
  const s = summarizeWorklist([outstanding("a", 30), outstanding("b", 2), clean("c", 90)], NOW);
  eq(s.oldestOutstandingDays, 30, "the longest WAITING entry, not the oldest entry");
  eq(oldestOutstandingDays([clean("c", 90)], NOW), null, "a clean entry sets no clock");
  eq(oldestOutstandingDays([], NOW), null, "and neither does an empty trail");
  const head = worklistHeadline(s);
  assert(/waiting 30 days/.test(head), "and the headline carries it");
}

// A HEADLINE WITH NO READABLE AGE omits the clause rather than naming zero days,
// which would be the reassuring reading of an unknown.
{
  const s = summarizeWorklist(
    [entry({ auditId: "x", createdAt: "nope", residuals: [{ table: "bookings", residual: 1 }] })],
    NOW,
  );
  eq(s.oldestOutstandingDays, null, "no readable outstanding stamp measures nothing");
  const head = worklistHeadline(s);
  assert(/warehouse/.test(head), "the headline still reports the outstanding count");
  assert(!/waiting/.test(head), "without claiming how long");
  assert(!/null|NaN|undefined/.test(head), "and leaking nothing");
}

// -------------------------------------------------------------- the caveat note

// The page must NOT render a due date, and must say why. This is the assertion
// that fails if somebody later "improves" the page by computing one.
{
  const note = deadlineNote();
  assert(new RegExp(`${ERASURE_RESPONSE_DAYS} days`).test(note), "the note names the stated deadline");
  assert(/runs from the day the person asked/.test(note), "and what that deadline is measured from");
  assert(/Slate does not record that day/.test(note), "and that Slate does not hold it");
  assert(/floor/.test(note), "so the days shown are a floor");
  assert(/no due date is shown/.test(note), "and it says plainly that no due date is offered");
}

finish();

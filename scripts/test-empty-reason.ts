/**
 * #1328: telling a lead we are CLOSED apart from telling them we are BUSY.
 *
 * "All times are taken right now. Check back soon." is untrue in both halves
 * whenever the reason is a closure: nothing is taken, we are shut, and soon may be
 * a week. The lead reads it as a busy week, comes back tomorrow to the same
 * screen, and is never told anything.
 *
 * The asymmetry this file exists to pin: "closed" may only be said when EVERY day
 * the booker searched was shut. If any searched day was open, the emptiness is
 * about supply (full, or nobody rostered) and claiming a closure would be its own
 * lie, in the opposite direction. Getting that backwards is the whole risk here,
 * because both wrong answers read perfectly plausibly on the screen.
 *
 * Run: node --experimental-strip-types scripts/test-empty-reason.ts
 */
import { emptyReason } from "../src/lib/availability/empty-reason.ts";
import type { BusinessWindow } from "../src/lib/booking/business-hours.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
/** Monday to Saturday open, Sunday shut: Slate's seeded week. */
// The REAL BusinessWindow shape (snake_case, as stored), typed so a rename cannot
// leave these fixtures quietly describing a shape the code no longer takes.
const open = (weekday: number): BusinessWindow => ({
  weekday,
  start_minute: 480,
  end_minute: 1020,
});
const MON_TO_SAT: BusinessWindow[] = [1, 2, 3, 4, 5, 6].map(open);
const WEEKDAYS_ONLY: BusinessWindow[] = [1, 2, 3, 4, 5].map(open);

const reason = (businessHours: BusinessWindow[], fromDay: string, searchedDays: number) =>
  emptyReason({ businessHours, fromDay, searchedDays, zone: ZONE });

// -------------------------------------------------- busy, not closed

{
  // 2026-08-10 is a Monday. Six days searched from an open Monday: the org was
  // open, so an empty result is about supply and must not claim a closure.
  const r = reason(MON_TO_SAT, "2026-08-10", 6);
  eq(r.kind, "busy", "an open day in the window means this is supply, not a closure");
}

{
  // The case that matters most today: the org is open and nobody is rostered
  // (the whole pool is off, #1272). Still not a closure. Saying "we are closed"
  // here would be the same class of lie in the other direction.
  const r = reason(MON_TO_SAT, "2026-08-10", 1);
  eq(r.kind, "busy", "an unstaffed open day is busy, never closed");
}

{
  // 2026-08-16 is a Sunday, shut, but Monday is inside a two day search.
  const r = reason(MON_TO_SAT, "2026-08-16", 2);
  eq(r.kind, "busy", "one shut day at the start of an otherwise open window is not a closure");
}

// -------------------------------------------------- genuinely closed

{
  // A Sunday, and only that Sunday was searched.
  const r = reason(MON_TO_SAT, "2026-08-16", 1);
  eq(r.kind, "closed", "a window entirely inside a shut day is a closure");
  if (r.kind === "closed") eq(r.reopensOn, "2026-08-17", "and names the Monday we are back");
}

{
  // A weekday-only week, searched across Saturday and Sunday.
  const r = reason(WEEKDAYS_ONLY, "2026-08-15", 2);
  eq(r.kind, "closed", "a whole shut weekend is a closure");
  if (r.kind === "closed") eq(r.reopensOn, "2026-08-17", "reopening on the Monday");
}

{
  // The reopening day is found beyond the searched window, which is the point:
  // the search is bounded for cost (#1326), so the day we are back is usually
  // OUTSIDE it and would otherwise be unnameable.
  const r = reason(WEEKDAYS_ONLY, "2026-08-15", 2);
  if (r.kind === "closed") {
    assert(r.reopensOn! > "2026-08-16", "the reopening day may lie past the searched window");
  }
}

// ----------------------------------------- nothing is open at all

{
  // A misconfigured week with no open day. This is not a closure with a return
  // date, and inventing one would be worse than naming none.
  const r = reason([], "2026-08-10", 6);
  eq(r.kind, "closed", "no open weekday at all reads as closed");
  if (r.kind === "closed") eq(r.reopensOn, null, "with no date, because there is none to give");
}

// -------------------------------------------------- degenerate inputs

{
  eq(reason(MON_TO_SAT, "2026-08-16", 0).kind, "busy", "searching no days claims no closure");
  eq(reason(MON_TO_SAT, "not-a-date", 6).kind, "busy", "an unreadable start claims no closure");
}

// Both degenerate cases fall to "busy" deliberately: the existing copy is merely
// unhelpful, while a wrongly claimed closure names a date the lead will act on.
// The safe direction for an answer we cannot compute is the vaguer one.

finish();

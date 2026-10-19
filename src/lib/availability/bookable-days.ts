/**
 * Offering the next N BOOKABLE days rather than a fixed calendar window (#1326).
 *
 * Pure (luxon only, no `@/` imports) so the node suite drives it directly.
 *
 * ## What changed and why
 *
 * `horizon_days` used to be a calendar window: today plus N days, take whatever
 * bookable days fall inside. Closed days inside the window were simply lost, so a
 * lead saw fewer choices for a reason invisible to them. With Sunday closed, a
 * Thursday or Friday afternoon could offer a single day: today drops out after
 * 14:40 (agents finish at 17:00, the slot is 20 minutes, notice is 120), the
 * weekend contributes nothing, and the window ends before the next open day.
 *
 * So the window becomes a SEARCH range and the answer is trimmed to the first N
 * days that actually produced times. The strip is then the same length whatever is
 * closed in between.
 *
 * ## The cost, which is why the search is bounded
 *
 * Per-bucket recompute is roughly super-linear in the window (`booking/settings.ts`
 * records this as the reason the cap is 7 and a 14 day horizon was never adopted,
 * even after the 200 agent load soak passed, #440). An unbounded walk would let one
 * long closure blow up the recompute lane,
 * which four every-minute lanes share. So the allowance is a few days: enough to
 * clear a weekend, not enough to clear a fortnight's shutdown. Across a closure
 * longer than that the honest answer is fewer days, not a bigger bill.
 */
import { DateTime } from "luxon";

/**
 * Extra calendar days searched beyond the number of bookable days wanted.
 *
 * TWO, and the number was measured rather than guessed. Widening the window costs
 * recompute on EVERY bucket on EVERY pass, on an invocation four minute-lanes share,
 * so it buys exactly the closed runs that really happen and no more. At 200 agents
 * over a four day horizon:
 *
 *     +1 (5 day window)   +23%   clears a closed Sunday
 *     +2 (6 day window)   +35%   clears a closed Sunday and a Monday holiday
 *     +3 (7 day window)   +48%   clears a three day closure
 *
 * Two is the smallest that covers the real world: US public holidays land on
 * Mondays, so a closed Sunday followed by a holiday Monday is a two day run, and an
 * allowance of one would come up a day short exactly then. Beyond two, the honest
 * answer is fewer days rather than a bigger bill on every pass forever.
 *
 * Do not raise this without re-measuring. `booking/settings.ts` records that a 14
 * day horizon was never adopted for this reason, even after the 200 agent load soak
 * passed (#440), and that the horizon stays at four days (#2360), which since #2840
 * is the last resort's reach rather than what a lead is offered.
 */
export const MAX_CLOSED_RUN_DAYS = 2;

/*
 * How many OPEN business days a lead is offered (#2840) used to be a constant here,
 * `OFFERED_OPEN_DAYS = 3`, counted by `openDaysWindowEndMs` before the last resort
 * opens more (#2841). Sales ops, 2026-09-28 (Slack #C091G6LEQ80,
 * p1790609176877419), Sam: "You want to contain to 3 days. Cascade down with rule
 * set. All else fails, day 4 which is 100% open."
 *
 * Since #3922 it is a stored setting, `booking_settings.offered_open_days` (default
 * 3), edited on the Hours page and read through `src/lib/booking/days-offered-load.ts`;
 * its rules are in `src/lib/booking/days-offered.ts`. The constant is gone rather
 * than kept as a fallback, so nothing can read the coded number as the live one.
 */

/** How many calendar days to compute over, to find `bookableDays` days of times. */
export function searchWindowDays(bookableDays: number): number {
  return bookableDays + MAX_CLOSED_RUN_DAYS;
}

/**
 * Keep only the slots falling on the first `n` days that have any slot at all,
 * grouped by the ORG's local date.
 *
 * The zone matters: a slot at 21:00 New York is stored as the next day in UTC, and
 * grouping in UTC would file it as a separate day, spending one of the N on a day
 * the customer does not have.
 *
 * Returns FEWER than `n` when fewer days have times. That is the honest answer, and
 * it is what a genuinely long closure looks like; nothing is invented to fill the
 * count. An unreadable instant is dropped and does not consume a day either, since
 * a day is a promise someone can book it.
 */
export function trimToBookableDays(slots: string[], zone: string, n: number): string[] {
  if (n <= 0) return [];

  const dated: { iso: string; ms: number; day: string }[] = [];
  for (const iso of slots) {
    const dt = DateTime.fromISO(iso, { zone });
    if (!dt.isValid) continue;
    const day = dt.toISODate();
    if (day === null) continue;
    dated.push({ iso, ms: dt.toMillis(), day });
  }
  dated.sort((a, b) => a.ms - b.ms);

  const keep = new Set<string>();
  for (const d of dated) {
    if (keep.size >= n && !keep.has(d.day)) break;
    keep.add(d.day);
  }
  return dated.filter((d) => keep.has(d.day)).map((d) => d.iso);
}

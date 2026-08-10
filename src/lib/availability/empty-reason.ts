/**
 * Why the booker has nothing to offer (#1328).
 *
 * With no times, the booker said "All times are taken right now. Check back soon."
 * Both halves are untrue whenever the reason is a CLOSURE rather than demand:
 * nothing is taken, we are shut, and "soon" may be a week. A lead reads it as a
 * busy week, comes back tomorrow to the same screen, and is never told anything.
 *
 * Pure (luxon only, no `@/` imports) so the node suite drives it directly.
 */
import { DateTime } from "luxon";
import type { BusinessWindow } from "../booking/business-hours.ts";

export type EmptyReason =
  | {
      /** Every day we looked at is a day the org is shut. */
      kind: "closed";
      /** The first day we are open again, as an ISO date in the org's zone.
       *  Null when no weekday is open at all, which is a misconfiguration rather
       *  than a closure, and must not be reported as a date. */
      reopensOn: string | null;
    }
  /** The org was open on at least one searched day and still produced nothing:
   *  either genuinely full, or nobody rostered. Either way not a closure. */
  | { kind: "busy" };

/** How far ahead to look for the reopening day. A month is generous for a holiday
 *  shutdown and bounded, so a misconfigured week cannot walk forever. */
const REOPEN_SEARCH_DAYS = 31;

/**
 * Decide why an empty result is empty.
 *
 * "Closed" means every day in the window the booker actually searched is a shut
 * weekday. If ANY searched day was open, the emptiness is about supply, not about
 * opening hours, and saying we are closed would be its own lie.
 *
 * `openWeekdays` comes from the org's stored business hours (Luxon weekdays,
 * 1 = Monday), which the availability path already has in hand, so this needs no
 * extra read.
 */
export function emptyReason(input: {
  /** Open windows only, as `loadBusinessHours` returns them. */
  businessHours: BusinessWindow[];
  /** Start of the searched window, an ISO date in the org's zone. */
  fromDay: string;
  /** How many calendar days were searched, inclusive of `fromDay`. */
  searchedDays: number;
  zone: string;
}): EmptyReason {
  const openWeekdays = new Set(input.businessHours.map((w) => w.weekday));
  const start = DateTime.fromISO(input.fromDay, { zone: input.zone });
  if (!start.isValid || input.searchedDays <= 0) return { kind: "busy" };

  for (let i = 0; i < input.searchedDays; i++) {
    if (openWeekdays.has(start.plus({ days: i }).weekday)) {
      // At least one searched day was open, so this is supply, not a closure.
      return { kind: "busy" };
    }
  }

  // Every searched day was shut. Walk on for the reopening day, which is the one
  // fact that makes the message actionable rather than just honest.
  for (let i = input.searchedDays; i < REOPEN_SEARCH_DAYS; i++) {
    const day = start.plus({ days: i });
    if (openWeekdays.has(day.weekday)) {
      return { kind: "closed", reopensOn: day.toISODate() };
    }
  }
  // No open weekday within the month: the week is misconfigured (or every day is
  // shut), and naming a date we invented would be worse than naming none.
  return { kind: "closed", reopensOn: null };
}

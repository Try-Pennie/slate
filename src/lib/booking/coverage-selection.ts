import { parseStampMs } from "@/lib/date/stamp";

/**
 * Which of an absent agent's bookings a coverage sweep moves (#1237).
 *
 * ONE rule, in one place, because the query that selects the bookings and any count that
 * reports them must mean the same thing by "needs covering". Two definitions would let the
 * preview, the sweep and the monitor disagree about the same gap (L16).
 *
 * Three conditions, each catching a different way of getting it wrong:
 *
 *   `starts_at > now`          never touch an appointment already under way. The customer may
 *                              be sitting in it, and moving it out from under them is worse
 *                              than the advisor being late to their own absence.
 *   `starts_at < window_end`   it has to begin before the absence ends, or it is not the
 *                              absence's problem.
 *   `ends_at   > window_start` it has to still be running when the absence begins. THIS is
 *                              the one the original query missed: it floored the start at the
 *                              window start, so an appointment beginning before the window and
 *                              running into it was never selected, and the customer kept a
 *                              slot with an advisor who is away for part of it.
 *
 * No lead-time threshold, deliberately. Everything still ahead moves, because the advisor is
 * definitely absent and the alternative is a customer in an empty meeting.
 */

export interface CoverageWindow {
  startIso: string;
  /** null for an open ended absence: everything from the start onward is in scope. */
  endIso: string | null;
}

/** The bounds the store hands to PostgREST, derived from the same rule as the predicate. */
export function coverageSelectionBounds(
  window: CoverageWindow,
  nowIso: string,
): { startsAfterIso: string; startsBeforeIso: string | null; endsAfterIso: string } {
  return {
    // NOW, not the window start. Flooring at the window start is what hid the straddling case.
    startsAfterIso: nowIso,
    startsBeforeIso: window.endIso,
    endsAfterIso: window.startIso,
  };
}

/**
 * Does this booking need covering?
 *
 * An unreadable timestamp answers NO. `Date.parse` yields NaN and every comparison with NaN is
 * false, so that is also what the arithmetic would do, but it is stated explicitly because the
 * harm is asymmetric: moving a booking is a customer-visible action, and taking it on a value
 * we could not read is worse than leaving one behind for a human to notice (L50).
 */
export function movesUnderCoverage(
  booking: { startsAtIso: string; endsAtIso: string },
  window: CoverageWindow,
  nowIso: string,
): boolean {
  const starts = parseStampMs(booking.startsAtIso);
  const ends = parseStampMs(booking.endsAtIso);
  const now = parseStampMs(nowIso);
  const windowStart = parseStampMs(window.startIso);
  const windowEnd = window.endIso === null ? null : parseStampMs(window.endIso);
  if (starts === null || ends === null || now === null || windowStart === null) return false;
  if (window.endIso !== null && windowEnd === null) return false;

  if (starts <= now) return false;
  if (windowEnd !== null && starts >= windowEnd) return false;
  return ends > windowStart;
}

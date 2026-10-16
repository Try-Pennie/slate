// Shared retry policy for the durable drains (#445): the booking-outbox drain
// (processBookingOutbox) and the create-reservation drain (processBookingReservations)
// both re-attempt a failing row every cron tick. Without backoff a permanently-
// failing step is hit ~50 times in 50 minutes (each attempt calling Google /
// the Regal webhook); with it the retries spread out and a stuck row is alerted
// and eventually given up on. Pure (no imports) so it is node-native testable and
// shared by both drains without a circular import.

const BASE_MS = 60_000; // first retry waits 1 minute
const MAX_MS = 60 * 60_000; // capped at 1 hour

/**
 * Exponential backoff for the Nth retry attempt (1-based): 1, 2, 4, 8 ... minutes,
 * capped at 60. A non-positive count floors at the base so the delay is never <= 0.
 * Computed with a bounded shift (cap the exponent) so 2^n can't overflow.
 */
export function drainBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  // 2^26 minutes already dwarfs MAX_MS; cap the exponent so the multiply is safe.
  const factor = 2 ** Math.min(n - 1, 26);
  return Math.min(BASE_MS * factor, MAX_MS);
}

/** Alert (throttled) once a drained row has failed this many times - past a
 *  transient blip, into "something is genuinely wrong" territory. */
export const DRAIN_ALERT_AFTER = 5;

/** Stop re-attempting a row after this many failures. It stays in its table
 *  (status still pending, diagnosable via last_error) and was already alerted at
 *  DRAIN_ALERT_AFTER, so it surfaces for a human rather than retrying forever.
 *  Note: a stuck reservation whose booking never committed is typically culled first
 *  by the 24h retention sweep (deleteExpiredReservations), well before the
 *  exponential schedule reaches 50 attempts (~44h), so for those this cap is a
 *  backstop; the alert at DRAIN_ALERT_AFTER is the real signal. One whose booking
 *  COMMITTED with booking.created still owed is kept by that sweep (#3847) and does
 *  reach this cap; past it the sweep's daily `reservation_created_owed` page is what
 *  still names it. The outbox has no retention sweep, so there the row genuinely
 *  persists for diagnosis. */
export const DRAIN_GIVE_UP_AT = 50;

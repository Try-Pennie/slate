/**
 * Outcome names the load test driver records and the judge counts, in one place so the
 * two can never spell one differently (L41). A leaf module: it imports nothing, so the
 * driver and the judge can both take values from it without importing each other.
 */

/**
 * A request never sent because its bucket's times could not be read at all (#3348): a
 * first availability read refused, timed out or failed, with no earlier view to fall
 * back on. Not `no-slots-offered`, which is a bucket that answered with no times, and not
 * an unanswered request, since no booking was ever sent.
 */
export const AVAILABILITY_UNREAD = "availability-unread";

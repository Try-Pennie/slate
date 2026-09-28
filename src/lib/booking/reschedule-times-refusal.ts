/**
 * The refusal a booking keyed move times read answers with (#2827), and the one
 * sentence it is said in.
 *
 * A leaf with no imports on purpose: the shared slot picker reads it, and the
 * picker ships in the booker's bundle, which has no other use for the manage
 * page's copy. The sentence is re-exported as `RESCHEDULE_COPY.unavailable` from
 * `manage-copy.ts`, so the preview and every reader still find it there (L41).
 */

/** The refusal code the booking keyed move times read answers with. */
export const RESCHEDULE_TIMES_UNAVAILABLE_CODE = "RESCHEDULE_TIMES_UNAVAILABLE";

/**
 * The move times could not be served for this booking at all: the read keyed on
 * the manage token found no active advisor link booking. One sentence for every
 * cause, like the advisor link's own refusal, and a retry cannot fix it, so the
 * picker offers none.
 */
export const RESCHEDULE_TIMES_UNAVAILABLE_SENTENCE = "We cannot offer new times for this call right now.";

/**
 * The sentence for a move times read that was refused, or null for any other
 * failure. A retry cannot fix a refusal, so the shared picker shows this INSTEAD
 * of its ordinary "could not load" and offers no retry, as it does for the
 * advisor link's own refusal.
 */
export function rescheduleTimesRefusalSentence(payload: unknown): string | null {
  const code = (payload as { code?: unknown } | null)?.code;
  return code === RESCHEDULE_TIMES_UNAVAILABLE_CODE ? RESCHEDULE_TIMES_UNAVAILABLE_SENTENCE : null;
}

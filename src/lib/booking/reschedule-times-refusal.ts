import { RESCHEDULE_COPY } from "@/lib/booking/manage-copy";

/** The refusal code the booking-keyed move times read answers with (#2827). */
export const RESCHEDULE_TIMES_UNAVAILABLE_CODE = "RESCHEDULE_TIMES_UNAVAILABLE";

/**
 * The sentence for a move times read that was refused, or null for any other
 * failure (#2827). A retry cannot fix a refusal, so the shared picker shows this
 * INSTEAD of its ordinary "could not load" and offers no retry, as it does for the
 * advisor link's own refusal.
 */
export function rescheduleTimesRefusalSentence(payload: unknown): string | null {
  const code = (payload as { code?: unknown } | null)?.code;
  return code === RESCHEDULE_TIMES_UNAVAILABLE_CODE ? RESCHEDULE_COPY.unavailable : null;
}

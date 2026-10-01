/**
 * The cal.com dual-write outcome vocabulary, in one place (#1276).
 *
 * These strings are WRITTEN into `ooo_requests.side_effects` by the client and
 * READ back by the override sweep, which decides from them whether a row needs
 * another attempt and whether it should page. That makes them a contract between
 * two files, and a prefix match on a hand-typed message is exactly how the two
 * drift: reword the client's sentence and the sweep silently reverts to treating
 * "not in cal.com" as terminal, which is the defect #1276 exists to fix (L35:
 * classify once, never branch on a message substring written elsewhere).
 *
 * `scripts/test-calcom-outcomes.ts` drives the real client and asserts what it
 * produces is what the classifier recognises, so the contract is checked from
 * the producing end rather than restated at the consuming one (L26).
 *
 * No `@/` imports, so node scripts can drive it directly.
 */

/** cal.com is switched off. Terminal: no later tick can find this has changed. */
export const OUTCOME_NOT_CONFIGURED = "skipped: cal.com not configured";

/**
 * The agent has no cal.com account. PROVISIONAL: it stops being true the moment
 * they are added, so the sweep re-checks it as the absence approaches.
 */
export const OUTCOME_NOT_IN_CALCOM = "skipped: not in cal.com";

/** The full form the client writes, which carries the email for diagnosis. */
export function notInCalcomOutcome(agentEmail: string): string {
  return `${OUTCOME_NOT_IN_CALCOM} (${agentEmail})`;
}

/** A write that landed, or had nothing to do and never will. */
export const OUTCOME_OK_PREFIX = "ok";

/** Every skip, whether terminal or provisional. */
export const OUTCOME_SKIPPED_PREFIX = "skipped";

/**
 * cal.com has been marked retired on /admin/alerts (#2875). NOT terminal (#2890):
 * while cal.com is retired the sweep reads no rows at all, and once it is put back
 * the sweep retries this skip like a failure, so every absence approved during
 * retirement is copied into a cal.com that takes bookings again. Its own words rather than "not configured", because a reader of the time off
 * record should see that somebody retired cal.com, not that a key went missing.
 */
export const OUTCOME_CALCOM_RETIRED = "skipped: cal.com retired";

/**
 * Whether an outcome is the retired skip (#2890), judged in ONE place: the override
 * sweep retries it once cal.com is live, and a cancellation or change records the
 * block it left behind, so both must agree on what it looks like.
 */
export function isRetiredSkip(outcome: string): boolean {
  return outcome.startsWith(OUTCOME_CALCOM_RETIRED);
}

/**
 * A removal that found no override on the dates to remove (#2417). The client has
 * still rewritten the dates to what Slate says they should offer, so cal.com is
 * right; the outcome reports that the block was not there to undo. Prefix only:
 * the client appends the dates.
 */
export const OUTCOME_NOTHING_TO_REMOVE_PREFIX = "failed: no cal.com override was on";

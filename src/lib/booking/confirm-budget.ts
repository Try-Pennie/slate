/**
 * The one budget a lead's booking request runs under (#3102).
 *
 * The booker gives up at `REQUEST_TIMEOUT_MS` (20 seconds). A confirm makes many
 * Supabase reads and a few Google calls in a row, so per request deadlines alone
 * add up past that, and the lead gets the browser's own failure instead of our
 * retryable 503. So the whole request carries one expiry, and every Supabase and
 * Google call inside it waits only for what is left (`call-budget.ts`).
 *
 * Two parts, and the worst case is their sum:
 *
 *  - the CONFIRM budget, 12 seconds, for everything the request does;
 *  - a CLEANUP allowance, 2 seconds, that ignores the spent confirm budget, for
 *    the whole failure path a request still owes after it timed out: handing
 *    back the lead's rate limit hit, recording the outcome, reporting the error
 *    and sending the page. Without it each of those would fail at once, the lead
 *    would pay for our outage, and the outage itself would go unrecorded. One
 *    allowance per request: the route's failure path and the service's page
 *    beneath it share it rather than each adding 2 seconds.
 *
 * That is 14 seconds against the booker's 20, which leaves 6 for what no budget
 * can see: computation, which a Worker's clock does not advance across, and the
 * response's trip back. Pinned by `confirm-budget.test.ts`, which drives the real
 * clients against a dependency that answers just inside every limit.
 */
import { withinCallBudget, withinCleanupBudget } from "@/lib/call-budget";

export const BOOKING_CONFIRM_BUDGET_MS = 12_000;
export const BOOKING_CLEANUP_BUDGET_MS = 2_000;
export const BOOKING_CONFIRM_WORST_CASE_MS = BOOKING_CONFIRM_BUDGET_MS + BOOKING_CLEANUP_BUDGET_MS;

/** Run a lead facing booking request under the confirm budget. */
export function withinBookingConfirmBudget<T>(work: () => Promise<T>): Promise<T> {
  return withinCallBudget(BOOKING_CONFIRM_BUDGET_MS, "the booking confirm", work);
}

/** Run the cleanup a request owes the lead, under its own small allowance. */
export function withinBookingCleanupBudget<T>(work: () => Promise<T>): Promise<T> {
  return withinCleanupBudget(BOOKING_CLEANUP_BUDGET_MS, "the booking cleanup", work);
}

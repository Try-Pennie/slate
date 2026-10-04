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
import { withinCallBudget } from "@/lib/call-budget";
import { DependencyTimeoutError, timeoutAsRetryable } from "@/lib/booking/orchestration";
import { BOOKING_CLEANUP_BUDGET_MS, withinBookingCleanupBudget } from "@/lib/booking/cleanup-allowance";

// The allowance lives in its own module so the orchestration can open it too
// (#3215); re-exported so every route keeps importing the pair from here.
export { BOOKING_CLEANUP_BUDGET_MS, withinBookingCleanupBudget };

export const BOOKING_CONFIRM_BUDGET_MS = 12_000;
export const BOOKING_CONFIRM_WORST_CASE_MS = BOOKING_CONFIRM_BUDGET_MS + BOOKING_CLEANUP_BUDGET_MS;

/** Run a lead facing booking request under the confirm budget. */
export function withinBookingConfirmBudget<T>(work: () => Promise<T>): Promise<T> {
  return withinCallBudget(BOOKING_CONFIRM_BUDGET_MS, "the booking confirm", work);
}

/**
 * Run a whole booking request under the confirm budget, and answer a deadline
 * that escapes it (#3102).
 *
 * The budget covers everything the request does, including the reads a route
 * makes BEFORE it reaches the service (the rate limits, the reason options, the
 * paused booker flag, an advisor link). The service turns a deadline into the
 * retryable outage, but those reads are not in the service, so a deadline there
 * used to escape the route as an unhandled 500. `onTimeout` is the route's answer
 * to it, written in the route so its refusal is annotated and counted where the
 * catalog guard reads it, and run under the cleanup allowance, since the budget
 * that cut the read short is spent. Every other failure is rethrown unchanged.
 */
export function withinBookingRequest<T>(
  handle: () => Promise<T>,
  onTimeout: (timeout: DependencyTimeoutError) => Promise<T>,
): Promise<T> {
  return withinBookingConfirmBudget(async () => {
    try {
      return await handle();
    } catch (err) {
      const timeout = timeoutAsRetryable(err);
      if (!(timeout instanceof DependencyTimeoutError)) throw err;
      return withinBookingCleanupBudget(() => onTimeout(timeout));
    }
  });
}

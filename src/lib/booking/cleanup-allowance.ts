/**
 * The cleanup allowance a lead's booking request owes after a failure (#3102,
 * #3215), in its own module so the pure booking orchestration can open it.
 * `confirm-budget.ts` imports the orchestration for its error types, so the
 * orchestration importing it back would be a cycle; this file imports neither.
 *
 * `confirm-budget.ts` re-exports both names and explains the 12 plus 2 split.
 */
import { insideCallBudget, withinCleanupBudget } from "../call-budget.ts";

export const BOOKING_CLEANUP_BUDGET_MS = 2_000;

/** Run the cleanup a request owes the lead, under its own small allowance. */
export function withinBookingCleanupBudget<T>(work: () => Promise<T>): Promise<T> {
  return withinCleanupBudget(BOOKING_CLEANUP_BUDGET_MS, "the booking cleanup", work);
}

/**
 * Run cleanup the booking path owes after a failure (#3215): the compensation for
 * a Google event already written, a lease that must be handed back. By the time
 * the failure is known the confirm budget may be spent, and every call made under
 * it would then be refused at once, so inside a request it runs under the cleanup
 * allowance. The same paths also run from the cron drains, which carry no budget:
 * there it runs as it always has, each call on its own limit, rather than being
 * squeezed into an allowance sized for a lead who is waiting.
 */
export function withinOwedCleanup<T>(work: () => Promise<T>): Promise<T> {
  return insideCallBudget() ? withinBookingCleanupBudget(work) : work();
}

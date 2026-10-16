/**
 * The cleanup allowance a lead's booking request owes after a failure (#3102,
 * #3215), in its own module so the pure booking orchestration can open it.
 * `confirm-budget.ts` imports the orchestration for its error types, so the
 * orchestration importing it back would be a cycle; this file imports neither.
 *
 * `confirm-budget.ts` re-exports both names and explains the 12 plus 2 split.
 */
import { insideCallBudget, withinCleanupBudget, withinOwnCleanupBudget } from "../call-budget.ts";

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

/**
 * `withinOwedCleanup` for a lost race's rollback (#3439), the one cleanup owed in
 * the MIDDLE of a confirm: the confirm goes on to the next advisor afterwards, and
 * may lose another race seconds later. While the confirm budget has the whole
 * allowance to spare, each rollback gets an allowance of its own that ends inside
 * that budget (`withinOwnCleanupBudget`), so a second race's rollback is never
 * refused because the first spent the request's one shared allowance. Nearer the
 * end of the budget it is the shared allowance, as every other cleanup gets, so the
 * request's worst case stays the budget plus one allowance. On the cron drains,
 * which carry no budget, it runs as it always has.
 */
export function withinLostRaceCleanup<T>(work: () => Promise<T>): Promise<T> {
  return insideCallBudget() ? withinOwnCleanupBudget(BOOKING_CLEANUP_BUDGET_MS, "the lost race cleanup", work) : work();
}

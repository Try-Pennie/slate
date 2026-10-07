/**
 * What a confirm's commit chain costs, measured, so a confirm never STARTS one it
 * cannot finish inside its budget (#3338).
 *
 * The commit chain is the part of a confirm with side effects: the reservation
 * row, the advisor's calendar event, and the booking insert. A confirm cut off
 * part way through it leaves a pending reservation and an event, and the
 * reservation drain later finishes them into a booking for a lead who was told
 * their confirm failed and to try again (L12). So the confirm path asks, before it
 * writes anything, whether what its budget has left covers what the chain costs,
 * and otherwise answers the retryable timeout having started nothing.
 *
 * The cost is MEASURED, never typed (L224), from two places:
 *
 *  - this isolate's recent chains (`CommitCostLog`): from the reservation write to
 *    the insert's answer, the slowest of the last `COMMIT_COST_SAMPLES` that are
 *    still fresh. Several samples rather than one, so a single fast chain cannot
 *    talk a slow day down (L656). The work after the insert is left out on
 *    purpose: once the booking has committed, a budget running out there answers
 *    the booking and the drain finishes the rest (#3263).
 *  - this confirm's own slowest Google call so far (its live check): a measured
 *    floor for the chain's Google write, made on the request itself, so a confirm
 *    on an isolate that has run no chain yet (a cold one, or one in the shared line
 *    behind a leader on another isolate) is not judged against nothing.
 *
 * TWO RULES KEEP THE RECORD FROM LOCKING AN ISOLATE OUT (L465). A confirm the gate
 * refuses records nothing, so a sample that could only be displaced by a newer one
 * would, once it exceeded what later confirms have left, refuse every one of them
 * for as long as the isolate lives. So:
 *
 *  - only a chain that COMMITTED inside its budget is recorded (the caller's
 *    rule, `createHeld`): one cut off at the insert, failed, or answered after the
 *    budget was spent is not what a chain costs, only what a budget allowed;
 *  - a sample stops counting once it is older than `COMMIT_COST_MAX_AGE_MS`,
 *    whatever was recorded since, so even a slow chain that really happened holds
 *    confirms back for at most that long after it.
 *
 * Pure, and kept apart from the orchestration so the routes' live dependencies and
 * the suites' fakes build the same log.
 */
import { CONFIRM_CLAIM_LEASE_MS } from "./confirm-queue.ts";

/** How many recent chains the slowest is taken over. */
export const COMMIT_COST_SAMPLES = 8;

/**
 * How long a chain's cost counts for, from the moment it was recorded.
 *
 * The longest a confirm can still be working: its 12 second budget plus the 2
 * second cleanup allowance, the bound the confirm line leases a turn for
 * (`CONFIRM_CLAIM_LEASE_MS`, pinned equal to `BOOKING_CONFIRM_WORST_CASE_MS` by
 * `scripts/test-confirm-queue.ts`). A sample exists to judge the confirms running
 * alongside the one it measured, a crowd waiting behind its leader above all, and
 * every one of those started inside that bound; a sample older than it was taken
 * before any confirm now running began, so it describes another moment. It is
 * also the most a slow chain can hold an isolate's later confirms back for.
 */
export const COMMIT_COST_MAX_AGE_MS = CONFIRM_CLAIM_LEASE_MS;

/** One isolate's record of what its commit chains cost. */
export interface CommitCostLog {
  /** One chain that committed inside its budget: `ms` from the reservation write
   *  to the insert's answer, recorded at `atMs`. */
  record(ms: number, atMs: number): void;
  /** The slowest of the recent chains still fresh at `atMs`, or null when none is. */
  slowestRecentMs(atMs: number): number | null;
}

export function makeCommitCostLog(
  opts: { samples?: number; maxAgeMs?: number } = {},
): CommitCostLog {
  const samples = opts.samples ?? COMMIT_COST_SAMPLES;
  const maxAgeMs = opts.maxAgeMs ?? COMMIT_COST_MAX_AGE_MS;
  const recent: { ms: number; atMs: number }[] = [];
  return {
    record(ms, atMs) {
      if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(atMs)) return;
      recent.push({ ms, atMs });
      if (recent.length > samples) recent.shift();
    },
    slowestRecentMs(atMs) {
      const fresh = recent.filter((s) => atMs - s.atMs <= maxAgeMs);
      return fresh.length === 0 ? null : Math.max(...fresh.map((s) => s.ms));
    },
  };
}

/**
 * What a confirm should expect its commit chain to cost: the slowest recent chain
 * this isolate ran, and never less than the slowest Google call the confirm itself
 * has made. Zero when neither has been measured, which only a confirm that has
 * made no Google call can reach, and then only a spent budget refuses it.
 */
export function expectedCommitMs(m: { slowestRecentChainMs: number | null; slowestGoogleCallMs: number }): number {
  return Math.max(m.slowestRecentChainMs ?? 0, m.slowestGoogleCallMs);
}

/**
 * Whether what a confirm's budget has left covers work measured to need `neededMs`:
 * its commit chain, or (after a lost race) one more rung. Null `leftMs` is a confirm
 * running outside any budget (a suite, a drain), which nothing can cut off, so it
 * always may. A budget already spent never starts anything, however cheap the work
 * was measured to be.
 */
export function budgetCovers(leftMs: number | null, neededMs: number): boolean {
  if (leftMs === null) return true;
  return leftMs > 0 && leftMs >= neededMs;
}

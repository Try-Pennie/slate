import type { BulkReassignJobStatus } from "@/lib/db/types";

/**
 * The decision layer for STOPPING a coverage sweep (#1665).
 *
 * Approving time off enqueues a sweep that moves the agent's upcoming customer
 * appointments to colleagues (#1237). Cancelling the time off used to tear down
 * the calendar events and the busy block and say nothing to the sweep, so it went
 * on moving customers away from an advisor who is now going to be there, and each
 * of them got an invite from somebody else. There is no path that moves them back
 * (#1219 decision 4), so the only remedy is not to move them in the first place.
 *
 * Three states an appointment can be in when the cancellation lands, and this
 * layer is the whole of the difference between them:
 *
 *   not yet moved  flipped to 'cancelled' and never moved. The core of the fix.
 *   already moved  left exactly as it is. #1219 decision 4: the customer has been
 *                  told twice by now and the covering advisor holds the slot under
 *                  their own cap, so cancelling the time off does not move them
 *                  back. Nothing here touches a 'moved' item.
 *   mid move       the drain is holding it right now. This layer cannot and must
 *                  not reach into that: the guarantee is a conditional UPDATE, so
 *                  whichever of the two writes reaches the row first wins and the
 *                  other is refused. See the ordering note below.
 *
 * Pure, with injected IO, so every branch is drivable by
 * `scripts/test-coverage-sweep-cancel.ts` rather than living inside a query
 * nothing can assert against. That suite runs this against the real drain engine,
 * interleaved, which is the only way to exercise the third state at all.
 */

export interface CoverageSweepCancelDeps {
  /** Every sweep this time-off request produced. Usually one; a request modified
   *  to a different window and re-approved has one per window. */
  findJobs(): Promise<{ id: string; status: BulkReassignJobStatus }[]>;
  /** Flip the sweep to 'cancelled' WHILE IT IS STILL ACTIVE. A sweep that already
   *  drained stays 'done': there is nothing to stop, and relabelling it would lose
   *  the fact that it finished. */
  cancelJob(jobId: string): Promise<void>;
  /** Flip every item still waiting to move to 'cancelled', and answer how many
   *  rows that actually changed. The count is the database's own answer, not a
   *  read taken beforehand, so it is exactly what this call stopped. */
  cancelPendingItems(jobId: string): Promise<number>;
  /** How many of this sweep's appointments had already moved. Read AFTER the stop,
   *  so a row that was mid move and committed a moment ago is counted as moved
   *  rather than reported as stopped. */
  countMovedItems(jobId: string): Promise<number>;
}

export interface CoverageSweepCancelReport {
  /** How many sweeps were settled (0 when the request never produced one). */
  jobs: number;
  /** Appointments that were still waiting to move and now never will. */
  stopped: number;
  /** Appointments that had already moved and stay with the covering advisor. */
  alreadyMoved: number;
}

/**
 * Stop every sweep this time-off request produced.
 *
 * The order inside a job is deliberate and is the part worth reading.
 *
 * The JOB is cancelled FIRST, then its items. A crash between the two leaves a
 * cancelled sweep holding pending items, and the drain refuses an item whose sweep
 * is cancelled and records it as stopped, so the leftovers converge on their own.
 * The other order leaves an ACTIVE sweep with nothing pending, which is precisely
 * the stranded shape #1235 exists to prevent: nothing ever drains it, nothing ever
 * flips it, and the #1238 monitor treats a live sweep as a reason to stay quiet.
 *
 * Safe to run twice, by construction rather than by a guard: every write is
 * conditional on the state it is leaving, so a second run changes nothing and
 * reports `stopped: 0` because there is nothing left in a stoppable state.
 */
export async function cancelCoverageSweep(
  deps: CoverageSweepCancelDeps,
): Promise<CoverageSweepCancelReport> {
  const jobs = await deps.findJobs();
  let stopped = 0;
  let alreadyMoved = 0;
  for (const job of jobs) {
    await deps.cancelJob(job.id);
    stopped += await deps.cancelPendingItems(job.id);
    alreadyMoved += await deps.countMovedItems(job.id);
  }
  return { jobs: jobs.length, stopped, alreadyMoved };
}

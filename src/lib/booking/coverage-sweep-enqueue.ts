/**
 * The decision layer for enqueuing a coverage sweep idempotently (#1235).
 *
 * Creating a sweep is TWO writes, the job row then its items, so a crash or an
 * error between them leaves a job with status 'active' and ZERO items. Nothing
 * drains that: `markBulkReassignJobDoneIfDrained` only ever runs for a job a tick
 * actually touched, and a job with no pending items is never loaded, so it sits
 * active forever having moved nothing.
 *
 * That is why the unique key on (ooo_request_id, range_start, range_end) is not on
 * its own enough. A conflict handler that merely RETURNED the existing job would
 * convert a recoverable half-write into a permanent silent failure, and would
 * report success while doing it. The conflict path therefore re-snapshots the
 * bookings into the existing job and puts it back to active if it gained work:
 * idempotent AND convergent, rather than idempotent and amnesiac.
 *
 * The same path covers a routine case, not just a crash. `modifyOoo` on an
 * approved request clears its side effects and returns it to pending, and
 * `validateWindow` does not require the window to have changed, so a re-approval
 * can legitimately need the same window swept again. During the pending gap the
 * agent is bookable and new bookings land; re-snapshotting picks them up, where
 * refusing the duplicate would strand exactly those bookings.
 *
 * A sweep the request's own cancellation stopped (#1665) reaches this same path on
 * a re-approval, and needs one thing more than a crash does: its stopped items are
 * already there, so nothing is "newly added" and the sweep would be reactivated
 * with no pending work. `reArmCancelledItems` is what puts them back.
 *
 * Pure decision, injected IO, so every branch above is pinned by
 * `scripts/test-coverage-sweep-enqueue.ts` with fakes rather than living inside a
 * query nothing can assert against.
 */

/** The outcome of trying to insert the job row. `conflict` is specifically the
 *  unique-violation case (a sweep already exists for this request and window);
 *  every other error is a real error and must not be mistaken for it. */
export type InsertJobResult =
  | { ok: true; jobId: string }
  | { ok: false; conflict: boolean; message: string };

export interface CoverageSweepEnqueueDeps {
  /** The bookings to move right now: the job's work snapshot. */
  snapshotBookingIds(): Promise<string[]>;
  /** Insert the job row with this starting status. */
  insertJob(status: "active" | "done"): Promise<InsertJobResult>;
  /** The sweep that already exists for this request and window, if any. */
  findExistingJob(): Promise<{ id: string } | null>;
  /** Add these bookings as items, ignoring ones already present. Returns how many
   *  were NEWLY added, which is what decides whether the job gained work. */
  addItems(jobId: string, bookingIds: string[]): Promise<number>;
  /**
   * Put back to 'pending' the items this sweep had STOPPED (#1665), for the
   * bookings in the new snapshot. Returns how many rows that changed.
   *
   * Needed because `addItems` ignores duplicates: a stopped item already exists,
   * so re-snapshotting adds nothing and the sweep would gain no work and never be
   * reactivated. That is a silent nothing, which is the amnesiac failure this
   * layer exists to remove. Conditional on 'cancelled' at the database, so it can
   * never resurrect an item that MOVED and hand the same customer over twice.
   */
  reArmCancelledItems(jobId: string, bookingIds: string[]): Promise<number>;
  /** Put a job back to 'active' so the drain picks it up again. */
  reactivateJob(jobId: string): Promise<void>;
}

export async function enqueueCoverageSweep(
  deps: CoverageSweepEnqueueDeps,
): Promise<{ jobId: string; itemCount: number }> {
  const bookingIds = await deps.snapshotBookingIds();

  // A sweep with nothing to move is born 'done'. An empty window is a normal
  // outcome, not a failure: time off approved further ahead than the booking
  // horizon genuinely has no bookings in it yet.
  const inserted = await deps.insertJob(bookingIds.length > 0 ? "active" : "done");

  if (inserted.ok) {
    // Throws on failure by design: the caller records the failure and a retry
    // converges through the conflict path below. Returning quietly here is what
    // would leave the active-and-empty job behind.
    if (bookingIds.length > 0) await deps.addItems(inserted.jobId, bookingIds);
    return { jobId: inserted.jobId, itemCount: bookingIds.length };
  }

  if (!inserted.conflict) {
    throw new Error(`bulk-reassign job insert failed: ${inserted.message}`);
  }

  const existing = await deps.findExistingJob();
  if (!existing) {
    // The unique key said a row exists and the lookup disagrees. Reporting success
    // off that would be exactly the amnesiac failure this layer removes.
    throw new Error(
      "bulk-reassign job conflicted but no existing sweep was found for this request and window",
    );
  }

  if (bookingIds.length === 0) return { jobId: existing.id, itemCount: 0 };

  const added = await deps.addItems(existing.id, bookingIds);
  // A sweep this request's own cancellation (or a narrowing modification) stopped
  // (#1665). Re-approving the SAME window is a deliberate new decision, so the
  // appointments that were stopped are exactly the ones that should move now, and
  // they are already items, so `addItems` reports nothing. Re-arming them is what
  // keeps "cancel, then approve again" from being a sweep that queues silence.
  const reArmed = await deps.reArmCancelledItems(existing.id, bookingIds);
  // Only reactivate a job that actually gained pending work. Flipping a drained
  // job back to 'active' with nothing pending would recreate the stuck state this
  // exists to prevent, since nothing would ever flip it back to 'done'.
  if (added + reArmed > 0) await deps.reactivateJob(existing.id);
  return { jobId: existing.id, itemCount: bookingIds.length };
}

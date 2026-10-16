/**
 * The retention sweep for create reservations (#3126, #3847), and the page about
 * the reservations it keeps.
 *
 * A pending reservation older than a day is normally a create that never
 * committed: a crash the drain could not finish, or a lost race whose rollback was
 * never run. Its payload is the whole attendee record, so the sweep deletes it.
 *
 * One kind must never be deleted. Since #3844 a booking that COMMITTED while its
 * post commit work could not finish (its bucket stopped resolving, so booking.created
 * cannot be built) keeps its reservation pending, and that reservation is the only
 * record that Regal was never told about the booking. The sweep used to delete it
 * after a day like any other, so a missed `reservation_drain_stuck` page ended with
 * the record gone and nothing to show the send was owed.
 *
 * "Committed" is judged from stored state: an ACTIVE booking holds the
 * reservation's idempotency key, which is the one booking the drain's resume will
 * still deliver booking.created for. A booking on the key that has since been
 * cancelled or completed owes nothing; the resume settles that reservation itself
 * (`attemptReservation`), and this sweep deletes it like a stale one. The
 * reservation is deleted only once its work lands, so a committed reservation
 * still pending is a send still owed. Those
 * are kept, reported as `owed`, and paged daily as `reservation_created_owed` until
 * somebody sends it or removes the reservation by hand.
 *
 * Every candidate is read, not a batch of them, for two reasons: a kept row must
 * not occupy the batch and starve the stale rows behind it for ever, and the page's
 * all-clear needs the whole owed count, not one batch's. The candidates are rare
 * leftovers, so the whole set is small.
 *
 * Pure, with every read and write injected, so `scripts/test-reservation-retention.ts`
 * drives it with no database.
 */

export interface ExpiredReservation {
  id: string;
  idempotency_key: string;
}

export interface RetentionSeams {
  /** Every pending reservation created before the cutoff, all pages. THROWS on a
   *  failed read: an empty list is what a clean table returns. */
  listExpired: (olderThanIso: string) => Promise<ExpiredReservation[]>;
  /** Which of these idempotency keys an ACTIVE booking holds. THROWS on a failed
   *  read, so a reservation nobody could judge is never deleted. */
  committedKeys: (keys: string[]) => Promise<Set<string>>;
  /** Delete these reservations, sparing any a drain holds a lease on. Answers how
   *  many were deleted. THROWS when the delete is refused. */
  deleteIds: (ids: string[]) => Promise<number>;
}

export interface RetentionSweep {
  /** Reservations deleted this pass. */
  deleted: number;
  /** Ids of the reservations kept because their booking committed and its
   *  booking.created is still owed. Measured over every candidate. */
  owed: string[];
}

export async function sweepExpiredReservations(
  seams: RetentionSeams,
  olderThanIso: string,
  limit: number,
): Promise<RetentionSweep> {
  const candidates = await seams.listExpired(olderThanIso);
  if (candidates.length === 0) return { deleted: 0, owed: [] };
  const committed = await seams.committedKeys([...new Set(candidates.map((r) => r.idempotency_key))]);
  const owed: string[] = [];
  const stale: string[] = [];
  for (const r of candidates) {
    if (committed.has(r.idempotency_key)) owed.push(r.id);
    else stale.push(r.id);
  }
  const batch = stale.slice(0, Math.max(0, limit));
  const deleted = batch.length > 0 ? await seams.deleteIds(batch) : 0;
  return { deleted, owed };
}

export type OwedReservationOutcome =
  /** The sweep kept owed reservations and paged them. */
  | "paged"
  /** The sweep measured no owed reservation: the condition is over. */
  | "cleared"
  /** The sweep failed, so nothing is known and nothing was paged or cleared. */
  | "unmeasured";

/** How many owed reservation ids a page names. */
const PAGED_IDS = 10;

/**
 * Page about the kept reservations, or clear the page, from a sweep that MEASURED
 * the owed set. A failed sweep (`null`) does neither: it measured nothing (#1152).
 */
export async function settleOwedReservationAlert(
  sweep: RetentionSweep | null,
  seams: {
    page: (count: number, ids: string) => Promise<void>;
    resolve: () => Promise<void>;
  },
): Promise<OwedReservationOutcome> {
  if (sweep === null) return "unmeasured";
  if (sweep.owed.length > 0) {
    await seams.page(sweep.owed.length, sweep.owed.slice(0, PAGED_IDS).join(", "));
    return "paged";
  }
  await seams.resolve();
  return "cleared";
}

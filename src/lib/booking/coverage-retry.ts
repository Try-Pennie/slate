import type { BulkReassignJobStatus } from "@/lib/db/types";

/**
 * Hourly retry of stranded coverage calls (#3485 part C).
 *
 * When a coverage sweep cannot place a call it settles the item `unplaceable`, which is
 * terminal: nothing re-attempts it, so the call sits on an agent who will not be there
 * until a person moves it by hand. The reason it could not be placed is almost always
 * transient at the scale of hours (every eligible advisor happened to be busy for that
 * slot and its gaps right then), so re-attempting about once an hour places most of them
 * with no human at all.
 *
 * This is deliberately a RE-ARM, not a second placement engine: it flips the stranded
 * items back to `pending` and lets the existing every-five-minute drain do the live
 * verify and the move, under the drain's own lock and daily-cap serialization. Two rules
 * fall out of that choice, and they are why this is a function with injected IO:
 *
 *  - A `moved` or `cancelled` item must NEVER be re-armed (that would hand a customer to a
 *    second advisor, or undo a cancelled time off), so the write re-arms only rows still
 *    `unplaceable`, and a cancelled SWEEP is excluded here as well.
 *  - The sweep is NOT reactivated. The drain loads a `pending` item whatever its sweep's
 *    status (`loadPendingBulkReassignItems` keys on the item, not the job), so a re-armed
 *    call under a `done` sweep is still re-attempted, and leaving the sweep `done` keeps
 *    its finish timestamp stable. That matters to the monitor: dating a give-up by a finish
 *    time that an hourly reactivate/redone cycle churned forward would re-page the same
 *    call every hour (see `countableAt` in coverage-needs-human.ts).
 */

/** One stranded item the retry may re-arm, with the status of the sweep it belongs to. */
export interface RetryableUnplaceable {
  itemId: string;
  jobId: string;
  jobStatus: BulkReassignJobStatus;
}

/**
 * The reads the retryable selection draws on, already narrowed by the store's SQL (the
 * bookings map holds only active, upcoming ones). Pulled out so the "is this still
 * stranded" predicate is pure and tested rather than buried in store IO.
 */
export interface RetryableReads {
  items: { id: string; job_id: string; booking_id: string }[];
  /** bookingId -> current holder + pool state, for active+upcoming bookings ONLY; a missing
   *  entry means the booking is gone, inactive or in the past, so the item is not retryable. */
  holderByBooking: Map<string, { assignedUserId: string | null; inPool: boolean }>;
  jobById: Map<string, { status: BulkReassignJobStatus; outUserId: string; fromRedistribute: boolean }>;
}

/**
 * Which unplaceable items are STILL stranded and so worth re-arming (#3485). The same
 * predicate the monitor's `countStranded` applies (L342), so the retry and the page never
 * disagree about what counts: the booking is active and upcoming (enforced by the map), it
 * is still on the sweep's out agent, and it is not a Redistribute sweep whose agent is back
 * in the pool (#3597). Pure.
 */
export function selectRetryableUnplaceable(reads: RetryableReads): RetryableUnplaceable[] {
  const { items, holderByBooking, jobById } = reads;
  return items.flatMap((i) => {
    const holder = holderByBooking.get(i.booking_id);
    if (!holder) return []; // booking gone, inactive or in the past
    const job = jobById.get(i.job_id);
    if (!job) return [];
    // Already moved off the out agent: not stranded (re-arming would re-settle it `moved`).
    if (holder.assignedUserId !== job.outUserId) return [];
    // #3597: a Redistribute sweep whose agent is back IN THE POOL is covered; re-arming it
    // would have the drain move the call off the now-available agent. Scoped to Redistribute,
    // as the monitor is: a time-off sweep's agent stays in the pool but is away, so it counts.
    if (job.fromRedistribute && holder.inPool) return [];
    return [{ itemId: i.id, jobId: i.job_id, jobStatus: job.status }];
  });
}

/** The IO the retry needs; the route wires the real store reads and writes. */
export interface CoverageRetryDeps {
  /**
   * Unplaceable items whose booking is still ACTIVE and UPCOMING, each with its sweep's
   * status. Upcoming-only is enforced in the store (not this pure layer) so a call whose
   * time has already passed is never retried.
   */
  loadRetryable(): Promise<RetryableUnplaceable[]>;
  /**
   * Flip the given items `unplaceable` -> `pending`, conditional on the row still being
   * `unplaceable` (so a raced move or cancel is never re-armed), and return how many it
   * actually flipped.
   */
  reArm(itemIds: string[]): Promise<number>;
}

export interface CoverageRetrySummary {
  /** Items re-armed to pending this tick. */
  reArmed: number;
  /** Retryable rows the read returned, before the cancelled exclusion. */
  considered: number;
}

/**
 * Re-arm the stranded calls so the drain re-attempts them. Pure but for the injected IO.
 */
export async function retryUnplaceableCoverage(deps: CoverageRetryDeps): Promise<CoverageRetrySummary> {
  const rows = await deps.loadRetryable();
  // A cancelled sweep's calls are never retried: the time off was cancelled or narrowed,
  // so the move must not happen. Its items are normally already `cancelled` and so absent
  // from an unplaceable read, but a sweep cancelled AFTER an item settled unplaceable would
  // still surface here, so the exclusion is explicit.
  const live = rows.filter((r) => r.jobStatus !== "cancelled");
  if (live.length === 0) return { reArmed: 0, considered: rows.length };
  const reArmed = await deps.reArm(live.map((r) => r.itemId));
  return { reArmed, considered: rows.length };
}

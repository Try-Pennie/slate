import type { CoveragePlacement, CoverageSelection, GapOnlyReason } from "@/lib/booking/coverage-target";
import type { Booking, BulkReassignItem, BulkReassignItemStatus, BulkReassignJob } from "@/lib/db/types";
import { AttendeeEmailRefusedError, ATTENDEE_EMAIL_REFUSED_STAFF } from "@/lib/booking/attendee-email-refused";
import type { AuditEntry } from "@/lib/audit";
import { log } from "@/lib/log";
import { planDemotionRevert } from "@/lib/booking/demotion-revert";

/** The item statuses that stay on the out agent and need a manual force-override
 *  (#974): no covering agent could be placed, or the move exhausted its retries. */
export const ACTIONABLE_ITEM_STATUSES: BulkReassignItemStatus[] = ["unplaceable", "failed"];

/** The statuses where NOBODY has to do anything (#2122): the booking was gone,
 *  cancelled or completed before the sweep reached it, so there was no move to
 *  make. Named beside the actionable ones because the panel has to tell them
 *  apart, and drawing a skip as a failure is what made the mark disagree with its
 *  own counts. */
export const SKIPPED_ITEM_STATUSES: BulkReassignItemStatus[] = ["skipped"];

/** The status of a call the sweep moved (#3615), listed for a demotion sweep so its moves can be
 *  found and undone. */
export const MOVED_ITEM_STATUSES: BulkReassignItemStatus[] = ["moved"];

/**
 * How many items the bulk-reassign drain processes per tick. Each item does a
 * live verify wave plus a reassign (a Google create + delete), so this is kept
 * modest to stay well under the Worker CPU + subrequest ceiling the cron lanes
 * share (#760); the rest carry over to the next tick (the engine is resumable).
 */
export const BULK_REASSIGN_ITEMS_PER_TICK = 20;

/** The lease the every minute drain lane holds while it moves calls (#3120), and that the reroute
 *  drill takes before draining its own sweep (#3615). One spelling, so the two cannot drift apart
 *  and run side by side. */
export const BULK_REASSIGN_LANE_LOCK = "cron_bulk_reassign";

/**
 * How many times a single item may be processed before a transient failure
 * (a reassign error, or a verify outage that never clears) becomes a terminal
 * `failed` instead of retrying forever. A genuinely-full slot is `unplaceable`
 * immediately and does not consume retries.
 */
export const MAX_ITEM_ATTEMPTS = 5;

/** The minimal booking shape the engine's idempotency decisions need. */
export type BookingSnapshot = Pick<Booking, "id" | "status" | "assigned_user_id">;

/**
 * The booking changed between the sweep choosing a covering advisor and the move
 * committing (#1677): an admin's own reassign, a second sweep over the same advisor, or
 * the lead's reschedule. The reassign refused rather than overwrite it (migration 0196),
 * so nothing moved. Thrown by the live `reassign` dep; defined here, with no imports
 * behind it, so the engine can tell it apart without loading the booking service.
 */
export class BookingMovedMidMoveError extends Error {
  constructor() {
    super("The appointment changed while it was being moved.");
    this.name = "BookingMovedMidMoveError";
  }
}

/** What the move was decided on (#1677): the advisor it leaves and the start checked. */
export interface MoveExpectation {
  assignedUserId: string;
  startsAt: string;
}

/** The decided next state for one item; the drain persists it via `commitItemOutcome`. */
export interface ItemOutcome {
  status: BulkReassignItemStatus;
  /** The covering agent once moved (or the current assignee when already off the
   *  out agent); null for a non-move outcome. */
  targetUserId: string | null;
  /** Human-readable explanation for a non-`moved` outcome (shown in the #974 UI). */
  detail: string | null;
}

/** What a drain tick did, for the lane's log line + saturation signal. */
export interface BulkReassignDrainSummary {
  processed: number;
  moved: number;
  unplaceable: number;
  skipped: number;
  failed: number;
  pending: number;
  /** Items the tick refused because their sweep had been stopped (#1665). Counted
   *  separately from `skipped`: a skip is a fact about the booking, this is a fact
   *  about the sweep, and a tick that refused ten is not a tick that moved none. */
  cancelled: number;
  /**
   * Items whose row had moved on between this tick READING them and reaching them
   * (#1665). The tick writes nothing for these: the row already carries whatever
   * the other writer set, and only that writer knows what it means.
   *
   * Today the only writer that can produce this is a cancellation landing while a
   * tick is part way through its batch, which is exactly the case that must not
   * move a customer. It is not labelled 'cancelled' here because this count is
   * measured from a failed claim, not from a status anybody read (L11).
   */
  unclaimed: number;
}

/** Every side effect the engine needs; `service.ts` wires the real ones. */
export interface BulkReassignDeps {
  /** The oldest pending items across active jobs, bounded, each with its job. */
  loadPendingItems(limit: number): Promise<{ item: BulkReassignItem; job: BulkReassignJob }[]>;
  /** The booking's current status + assignment, or null if it no longer exists. */
  loadBooking(bookingId: string): Promise<BookingSnapshot | null>;
  /** Live-verified covering-agent selection for this booking (see coverage-target.ts). */
  selectTarget(booking: BookingSnapshot, job: BulkReassignJob): Promise<CoverageSelection>;
  /**
   * Reassign the booking onto `targetEmail` (adminReassignBooking); throws on failure.
   * `placement`, when the pick was on a lower rung of the tier ladder (#3485), is the
   * bucket the call moves into, through Reroute's hold and swap (`coverage-cascade.ts`).
   */
  reassign(
    bookingId: string,
    targetEmail: string,
    job: BulkReassignJob,
    placement?: CoveragePlacement,
    /** #1677: commit only if the booking is still with the out agent at the start the
     *  selection checked; throws `BookingMovedMidMoveError` otherwise. */
    expect?: MoveExpectation,
  ): Promise<void>;
  /**
   * Take this item for processing WHILE IT IS STILL PENDING, answering whether it
   * still was (#1665).
   *
   * A tick reads up to twenty items at once and then works through them one at a
   * time, each taking a live verify plus two Google writes, so the batch it is
   * holding can be minutes old by the time it reaches the last one. A cancellation
   * that lands in the middle of that has already stopped those rows in the
   * database, and without this the tick would go on moving customers off a
   * snapshot taken before anybody cancelled.
   *
   * It does NOT change the status, so nothing is left half claimed: a tick that
   * dies mid item leaves the row pending and the next tick picks it up, exactly as
   * before. The whole of it is the database answering "is this row still pending",
   * atomically, at the moment of asking.
   */
  claimItem(itemId: string): Promise<boolean>;
  /** Append a row to the audit trail (`recordAudit`, which never throws). Used for the moves a
   *  demotion sweep makes (#3615); see `demotionRerouteAudit`. */
  recordAudit(entry: AuditEntry): Promise<void>;
  /**
   * Which of these calls the demoted advisor holding them can take again under their tiers NOW
   * (#4052; `readCallsTakenAgain`, by the rule the sweep moved by). Asked only for a demotion
   * sweep's call, right before a new advisor is chosen.
   */
  callsTakenAgain(calls: readonly { bookingId: string; outUserId: string }[]): Promise<Set<string>>;
  /**
   * Persist an item's outcome and its new attempt count in one write.
   *
   * The lane lock serializes this against another TICK, but not against a
   * cancellation (#1665), which is a person pressing a button while a tick is
   * running. So the write is conditional on the status the item is leaving, and
   * the database decides: an item stopped underneath this tick keeps 'cancelled'
   * unless the outcome is a COMPLETED move, which must be recorded whichever write
   * arrived first, because the booking really is with somebody else now.
   */
  commitItemOutcome(itemId: string, outcome: ItemOutcome, attempts: number): Promise<void>;
  /** Flip the job to 'done' if it now has no pending items left, answering whether THIS call
   *  made the flip. The flip is conditional on the job still being active, so exactly one
   *  tick ever answers true for a job, which is what makes `jobFinished` say it once. */
  markJobDoneIfDrained(jobId: string): Promise<boolean>;
  /**
   * Report a sweep this tick finished (#3615): the demotion line, written from how its calls
   * settled. Called only after the done flip landed, so a throw cannot be retried into a second
   * report; the drain logs it and carries on with the next job.
   */
  jobFinished(job: BulkReassignJob): Promise<void>;
}

/** A transient failure after this attempt: retry while attempts remain, else fail. */
function retryOrFail(priorAttempts: number, detail: string): ItemOutcome {
  const status: BulkReassignItemStatus = priorAttempts + 1 >= MAX_ITEM_ATTEMPTS ? "failed" : "pending";
  return { status, targetUserId: null, detail };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The audit row for one call a DEMOTION sweep moved (#3615), or null for any other sweep, whose
 * moves are not this event. Who lost the call is the row's target; the details carry the
 * booking, both advisors, the sweep and what changed in Twilio (null when the earlier tiers were
 * never saved, which the reader sees as "not recorded" rather than an invented change). Pure.
 */
export function demotionRerouteAudit(job: BulkReassignJob, bookingId: string, toUserId: string): AuditEntry | null {
  if (!job.demotion_marked_at) return null;
  return {
    orgId: job.org_id,
    actorId: null,
    action: "booking.demotion_reroute",
    targetUserId: job.out_user_id,
    details: {
      booking_id: bookingId,
      job_id: job.id,
      from_user_id: job.out_user_id,
      to_user_id: toUserId,
      demotion_marked_at: job.demotion_marked_at,
      change: job.demotion_change ?? null,
    },
  };
}

/** Whether the demoted advisor can take this call again (#4052), false when that cannot be read. */
async function takenAgain(bookingId: string, job: BulkReassignJob, deps: BulkReassignDeps): Promise<boolean> {
  try {
    return (await deps.callsTakenAgain([{ bookingId, outUserId: job.out_user_id }])).has(bookingId);
  } catch (err) {
    log.error("bulk-reassign", { msg: "could not read whether the advisor takes the call again", booking_id: bookingId }, err);
    return false;
  }
}

/**
 * Decide (and, for a move, perform) one item's outcome. Every idempotency
 * decision keys off the booking's CURRENT assignment, which is the source of
 * truth for whether the covering swap has already committed:
 *
 *  - Sweep stopped (#1665) → `cancelled`, without reading the booking at all.
 *  - Booking gone / cancelled / completed → `skipped` (never a failure).
 *  - Booking already off the out agent → `moved` WITHOUT reassigning again. This
 *    is the crash-resume guard: if a prior tick committed the swap but died
 *    before marking the item, or someone reassigned the booking externally, the
 *    item is settled from the assignment, never double-moved.
 *  - Otherwise select a covering advisor by the booker's own rule (Reroute's search:
 *    the cached round robin, then the live verify, then the approved time off check,
 *    walking the tier ladder, see coverage-target.ts) and reassign, a pick on a lower
 *    rung moving into that rung's bucket through Reroute's hold and swap
 *    (coverage-cascade.ts): a placed move → `moved`; a genuinely-full slot →
 *    `unplaceable` (stays on the out agent for the manual force-override in #974); a
 *    verify outage or a reassign error → retried (`pending`) until
 *    `MAX_ITEM_ATTEMPTS`, then `failed`.
 *
 * Does not persist; the drain commits the returned outcome so the write and the
 * attempt increment are one step.
 */
export async function processBulkReassignItem(
  item: BulkReassignItem,
  job: BulkReassignJob,
  deps: BulkReassignDeps,
): Promise<ItemOutcome> {
  // The sweep was stopped because the time off was cancelled or narrowed (#1665).
  // Checked BEFORE the booking is even read: this appointment must not move, and
  // the reason has nothing to do with the booking.
  //
  // Cancelling a sweep is two writes, the job then its items, in that order. This
  // is what makes the pair convergent rather than merely ordered: an item the
  // second write never reached settles itself here, on the next tick, instead of
  // staying pending under a sweep nothing will ever drain.
  if (job.status === "cancelled") {
    return {
      status: "cancelled",
      targetUserId: null,
      detail: "The time off was cancelled before this appointment moved.",
    };
  }
  const booking = await deps.loadBooking(item.booking_id);
  if (!booking) {
    return { status: "skipped", targetUserId: null, detail: "Booking no longer exists." };
  }
  if (booking.status === "cancelled" || booking.status === "completed") {
    return {
      status: "skipped",
      targetUserId: null,
      detail: `Booking was ${booking.status} before it could be moved.`,
    };
  }
  if (booking.assigned_user_id !== job.out_user_id) {
    return {
      status: "moved",
      targetUserId: booking.assigned_user_id,
      detail: "Already reassigned off the out agent.",
    };
  }
  // #4052: a demoted advisor whose tier came back can take the call again, so it stays with
  // them. Asked here, where a call changes hands, so neither the hourly retry nor a tick that
  // was already holding the item can move it after the tier returned. If Twilio takes the tier
  // away again, that demotion opens a sweep of its own. A read that fails answers nothing and
  // the move goes ahead as before: a wrong move has an undo, a wrong keep strands a customer.
  if (job.demotion_marked_at && (await takenAgain(item.booking_id, job, deps))) {
    return {
      status: "skipped",
      targetUserId: null,
      detail: "The advisor can take this call again, so it stays with them.",
    };
  }

  const selection = await deps.selectTarget(booking, job);
  if (selection.assignment) {
    // #1677: the per item claim (#1665) covers the ITEM changing mid tick; this covers the
    // BOOKING. The move commits only if the booking is still with the out agent at the
    // start the selection checked, whoever else changed it in the seconds in between.
    const expect: MoveExpectation | undefined = selection.verifiedStartsAt
      ? { assignedUserId: job.out_user_id, startsAt: selection.verifiedStartsAt }
      : undefined;
    try {
      await deps.reassign(item.booking_id, selection.assignment.email, job, selection.placement, expect);
    } catch (err) {
      // Not a failed move: nothing moved, and the next tick reads the booking afresh,
      // settling it moved if somebody else placed it, or choosing again at a new time.
      if (err instanceof BookingMovedMidMoveError) {
        return retryOrFail(item.attempts, "The appointment changed while it was being moved; it will be looked at again.");
      }
      // #3373: Google will never invite this lead's address, so no retry can move
      // the booking: failed at once, saying why, rather than retried to the cap and
      // then shown as "Reassign failed: Enter a valid email address", a sentence
      // meant for the lead's own form.
      if (err instanceof AttendeeEmailRefusedError) {
        return { status: "failed", targetUserId: null, detail: ATTENDEE_EMAIL_REFUSED_STAFF };
      }
      return retryOrFail(item.attempts, `Reassign failed: ${errMessage(err)}`);
    }
    // #3615: written AFTER the move succeeded, and OUTSIDE the move's try, so the trail records
    // what happened and a trail write that ever threw could not report a completed move as a
    // failed one. Caught here too, because the item's outcome is the move, not the row. A tick
    // that dies between the two leaves the move in the booking's history without this row; the
    // crash-resume branch above cannot tell that case from somebody else moving the booking, so
    // it claims nothing rather than a move it may not have made.
    const audit = demotionRerouteAudit(job, item.booking_id, selection.assignment.userId);
    if (audit) {
      await deps.recordAudit(audit).catch((err: unknown) =>
        log.error("bulk-reassign", { msg: "demotion reroute audit row not written", booking_id: item.booking_id }, err),
      );
    }
    return { status: "moved", targetUserId: selection.assignment.userId, detail: null };
  }
  if (selection.anyUnverified) {
    return retryOrFail(item.attempts, "Calendar verify was unavailable; will retry.");
  }
  return {
    status: "unplaceable",
    targetUserId: null,
    // #3485: say availability, never the daily cap. Most event types carry no cap
    // (`event_types.daily_cap` is null), so "nobody was free and under their daily
    // cap" named a gate that never applied and pointed the reader at the wrong fix.
    // "Available" is the one thing always true when a slot is genuinely full: free,
    // within any cap, on shift, and not on time off.
    detail: unplaceableDetail(selection.gapOnly),
  };
}

/**
 * The unplaceable record (#3485). Says availability, and adds the gap only when the
 * selection MEASURED it as the reason: advisors free for the call itself but not for the
 * minutes kept clear around it, which is what a person placing it by hand needs to know,
 * since doing so puts the call back to back with another. Pure.
 */
export function unplaceableDetail(gapOnly?: GapOnlyReason): string {
  const base = "No other advisor was available to take this appointment at its original time.";
  if (!gapOnly || gapOnly.advisors <= 0) return base;
  const { advisors, beforeMin, afterMin } = gapOnly;
  const gap =
    beforeMin === afterMin
      ? `the ${afterMin} minutes kept clear before and after it`
      : beforeMin === 0
        ? `the ${afterMin} minutes kept clear after it`
        : afterMin === 0
          ? `the ${beforeMin} minutes kept clear before it`
          : `the ${beforeMin} minutes kept clear before it and the ${afterMin} after it`;
  const who = advisors === 1 ? "1 advisor was" : `${advisors} advisors were`;
  return `${base} ${who} free for the call itself, but not for ${gap}.`;
}

/**
 * Drain one bounded tick of the bulk-reassign engine. Processes each pending item
 * STRICTLY one at a time (await to completion, commit, then the next) so a
 * committed move is already reflected in the daily-cap count the next item's
 * target selection reads. The caller holds a per-lane lock so no two ticks run
 * concurrently; items left over carry to the next tick (resumable). After the
 * tick, each touched job is checked for completion.
 *
 * `stillHeld` is that lock's fence (#3120). The per item claim is not exclusive
 * (it leaves the item pending), so it is the lane lock alone that stops two ticks
 * moving bookings against the same daily cap count. A tick that overruns its TTL
 * renews the lock before each item and stops the moment another tick holds it.
 */
export async function drainBulkReassign(
  deps: BulkReassignDeps,
  limit: number = BULK_REASSIGN_ITEMS_PER_TICK,
  stillHeld: () => Promise<boolean> = async () => true,
): Promise<BulkReassignDrainSummary> {
  const pending = await deps.loadPendingItems(limit);
  const summary: BulkReassignDrainSummary = {
    processed: 0,
    moved: 0,
    unplaceable: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    cancelled: 0,
    unclaimed: 0,
  };
  const touchedJobs = new Map<string, BulkReassignJob>();
  for (const { item, job } of pending) {
    if (!(await stillHeld())) break;
    // The row may have been stopped since this batch was read (#1665). Ask the
    // database, per item, immediately before doing the work rather than trusting a
    // snapshot that can be minutes old.
    if (!(await deps.claimItem(item.id))) {
      summary.unclaimed++;
      touchedJobs.set(job.id, job);
      continue;
    }
    const outcome = await processBulkReassignItem(item, job, deps);
    await deps.commitItemOutcome(item.id, outcome, item.attempts + 1);
    summary.processed++;
    summary[outcome.status]++;
    touchedJobs.set(job.id, job);
  }
  for (const [jobId, job] of touchedJobs) {
    if (!(await deps.markJobDoneIfDrained(jobId))) continue;
    try {
      await deps.jobFinished(job);
    } catch (err) {
      log.error("bulk-reassign", { msg: "finished sweep could not be reported", job_id: jobId }, err);
    }
  }
  return summary;
}

/**
 * Drain ONE sweep's pending items, for the reroute drill (#3615).
 *
 * The every minute lane holds a lease while it works, because two ticks moving calls against one
 * daily cap count is what the lease exists to stop (#3120). So this takes the SAME lease. While the
 * lane holds it, this waits, and the lane may simply move the sweep's call itself on its next
 * tick, which is just as good: what is asked is that nothing is left pending, not who drained it.
 * A sweep still pending after every attempt THROWS, so it can never read as drained. The lease is
 * released whatever the drain does. The sleep is injected (L524).
 */
export async function drainOneJob(
  deps: {
    acquire(): Promise<{ release(): Promise<void>; stillHeld(): Promise<boolean> } | null>;
    drain(stillHeld: () => Promise<boolean>): Promise<void>;
    pendingCount(): Promise<number>;
    sleep(ms: number): Promise<void>;
  },
  opts: { attempts: number; waitMs: number },
): Promise<"drained"> {
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    if ((await deps.pendingCount()) === 0) return "drained";
    const lease = await deps.acquire();
    if (lease) {
      try {
        await deps.drain(() => lease.stillHeld());
      } finally {
        await lease.release();
      }
      if ((await deps.pendingCount()) === 0) return "drained";
    }
    if (attempt < opts.attempts) await deps.sleep(opts.waitMs);
  }
  throw new Error(`the sweep's call was still pending after ${opts.attempts} attempts to drain it`);
}

/** A job's per-status item counts for the progress read (#974). */
export interface BulkReassignSummary {
  total: number;
  counts: Record<BulkReassignItemStatus, number>;
  /** True when no item is still pending (mirrors the job-done rule). */
  done: boolean;
}

/**
 * Every status an item can hold, as a list, in ONE place.
 *
 * Written as a `Record` first so `tsc` names a status somebody adds to the union
 * and forgets here; the array is derived from it. Both the counter below and
 * `isBulkReassignProgress` read this, so the thing that COUNTS statuses and the
 * thing that JUDGES whether a payload carries them all can never answer
 * differently about which statuses exist (L41, L263).
 */
const ITEM_STATUS_PRESENT: Record<BulkReassignItemStatus, true> = {
  pending: true,
  moved: true,
  unplaceable: true,
  skipped: true,
  failed: true,
  cancelled: true,
};
export const BULK_REASSIGN_ITEM_STATUSES = Object.keys(ITEM_STATUS_PRESENT) as BulkReassignItemStatus[];

/** Count a job's items by status for the admin progress view. Pure. */
export function summarizeBulkReassignItems(
  items: { status: BulkReassignItemStatus }[],
): BulkReassignSummary {
  const counts = Object.fromEntries(BULK_REASSIGN_ITEM_STATUSES.map((s) => [s, 0])) as Record<
    BulkReassignItemStatus,
    number
  >;
  for (const it of items) counts[it.status]++;
  return { total: items.length, counts, done: counts.pending === 0 };
}

/** Minimal booking display context for an actionable item row (#974). */
export interface ActionableBookingContext {
  startsAt: string;
  attendeeName: string | null;
  /** The booking's status and current advisor (#3615), which decide whether a moved call can
   *  still go back. Optional so a caller with only display context passes none. */
  status?: string;
  assignedUserId?: string | null;
}

/** One actionable ("couldn't place") item for the progress view (#974). */
export interface BulkReassignActionableItem {
  bookingId: string;
  status: BulkReassignItemStatus;
  detail: string | null;
  startsAt: string | null;
  attendeeName: string | null;
  /** When an admin moved this call back after a demotion move (#3615); absent or null otherwise,
   *  including from a server older than the field. */
  revertedAt?: string | null;
  /** Whether a demotion move can STILL go back (#3615), judged by the booking page's own planner,
   *  so the row offers only what the rules permit now (L1007). Absent when it was not judged. */
  canMoveBack?: boolean;
}

export interface BulkReassignProgress {
  job: BulkReassignJob;
  summary: BulkReassignSummary;
  /** Unplaceable + failed items, each linkable to the single-reassign force-override. */
  actionable: BulkReassignActionableItem[];
  /**
   * Items nobody has to do anything about (#2122): the booking was gone,
   * cancelled or completed before the sweep reached it, so there was no move to
   * make.
   *
   * A SEPARATE list from `actionable`, deliberately. Actionable means a person
   * still has to place it by hand; a skip means the appointment is not happening.
   * Merging them is the conflation the panel's mark used to make, where a skip was
   * drawn in the same rose as a failure and the boxes outnumbered the count.
   *
   * Carried at all because the count alone was unreadable: a number with no
   * consequence is a fact the reader has to work out, and every skip already holds
   * its own detail saying which of the three it was.
   */
  skipped: BulkReassignActionableItem[];
  /**
   * The calls a DEMOTION sweep moved (#3615), each linking to the booking where the move back
   * lives. Nothing else tells a person which calls an automatic reroute moved. Empty for every
   * other sweep, whose moves the person watching asked for. Optional on the wire: a reply from a
   * server older than this field reads as none (L598).
   */
  moved?: BulkReassignActionableItem[];
}

/**
 * Assemble the admin progress view from a job, its items, and display context for
 * the actionable bookings (#974). Pure: the summary counts every item, and the
 * actionable list is the unplaceable + failed items (the ones still on the out
 * agent) enriched with booking context for display. The DB reads live in the
 * service; this is the composition, so it is node-tested.
 */
export function buildBulkReassignProgress(
  job: BulkReassignJob,
  items: BulkReassignItem[],
  bookingCtx: Map<string, ActionableBookingContext>,
  /** The planner's other inputs, for a demotion sweep's moved calls (#3615): the advisor the
   *  calls left, and now. Absent means the rows say nothing about whether they can go back. */
  moveBack?: { original: { email: string | null; deactivated_at: string | null } | null; nowMs: number },
): BulkReassignProgress {
  // #3615: whether a moved call can still go back, by the SAME planner the booking page runs
  // (L263, L342). A booking that could not be read cannot be moved back from here.
  const canMoveBackOf = (it: BulkReassignItem): boolean => {
    const ctx = bookingCtx.get(it.booking_id);
    if (!moveBack || !ctx || ctx.status === undefined || !job.demotion_marked_at) return false;
    const plan = planDemotionRevert({
      move: {
        itemId: it.id,
        bookingId: it.booking_id,
        jobId: job.id,
        orgId: job.org_id,
        outUserId: job.out_user_id,
        toUserId: it.target_user_id,
        status: it.status,
        movedAt: it.updated_at,
        demotionMarkedAt: job.demotion_marked_at,
        change: null,
        revertedAt: it.reverted_at ?? null,
        revertedBy: it.reverted_by ?? null,
      },
      booking: { status: ctx.status, assigned_user_id: ctx.assignedUserId ?? null, starts_at: ctx.startsAt },
      original: moveBack.original,
      nowMs: moveBack.nowMs,
    });
    return plan.kind !== "refused";
  };
  const summary = summarizeBulkReassignItems(items);
  const rowsOf = (statuses: readonly BulkReassignItemStatus[]) =>
    items
      .filter((it) => statuses.includes(it.status))
      .map((it) => ({
        bookingId: it.booking_id,
        status: it.status,
        detail: it.detail,
        startsAt: bookingCtx.get(it.booking_id)?.startsAt ?? null,
        attendeeName: bookingCtx.get(it.booking_id)?.attendeeName ?? null,
        // Only on a call that was moved back, so the other lists' rows are unchanged.
        ...(it.reverted_at ? { revertedAt: it.reverted_at } : {}),
        ...(moveBack && it.status === "moved" ? { canMoveBack: canMoveBackOf(it) } : {}),
      }));
  // One shape for both lists, from one function, so the panel can draw them with
  // one row component and the two cannot drift into different fields.
  return {
    job,
    summary,
    actionable: rowsOf(ACTIONABLE_ITEM_STATUSES),
    skipped: rowsOf(SKIPPED_ITEM_STATUSES),
    moved: job.demotion_marked_at ? rowsOf(MOVED_ITEM_STATUSES) : [],
  };
}

/**
 * Is this reply really a progress payload (#2135)?
 *
 * The panel used to read `progress.summary.done` off whatever a 200 carried, so a
 * body of the wrong shape threw during render and the admin page's error boundary
 * blanked the WHOLE page rather than the one panel. `getJson` refuses a non-ok
 * response, so the case this exists for is the successful but wrong one: a shape
 * change, a page older than the server it is talking to (L598), or something else
 * answering 200.
 *
 * It checks what the panel READS, and the counts are checked against
 * `BULK_REASSIGN_ITEM_STATUSES` rather than a second list written here, so a status
 * added to the engine is required of the payload without anybody remembering.
 * A field the panel does not read is ignored: refusing an unfamiliar extra would
 * turn every additive server change into an unreadable reply for pages already open.
 */
export function isBulkReassignProgress(value: unknown): value is BulkReassignProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;

  const job = v.job;
  if (typeof job !== "object" || job === null || typeof (job as { id?: unknown }).id !== "string") {
    return false;
  }

  const summary = v.summary;
  if (typeof summary !== "object" || summary === null) return false;
  const s = summary as Record<string, unknown>;
  if (!Number.isFinite(s.total) || typeof s.done !== "boolean") return false;
  const counts = s.counts;
  if (typeof counts !== "object" || counts === null) return false;
  const c = counts as Record<string, unknown>;
  for (const status of BULK_REASSIGN_ITEM_STATUSES) {
    if (!Number.isFinite(c[status])) return false;
  }

  return (
    isProgressRowList(v.actionable) &&
    isProgressRowList(v.skipped) &&
    (v.moved === undefined || isProgressRowList(v.moved))
  );
}

/** One `actionable` / `skipped` row, as the panel draws it. A row whose status is
 *  not one the engine can produce is refused, because the panel decides whether to
 *  offer "Place by hand" by asking whether that status is a skip, and an unknown
 *  status would silently answer no. */
function isProgressRowList(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((row) => {
    if (typeof row !== "object" || row === null) return false;
    const r = row as Record<string, unknown>;
    if (typeof r.bookingId !== "string") return false;
    if (!BULK_REASSIGN_ITEM_STATUSES.includes(r.status as BulkReassignItemStatus)) return false;
    return (
      (r.detail === null || typeof r.detail === "string") &&
      (r.startsAt === null || typeof r.startsAt === "string") &&
      (r.attendeeName === null || typeof r.attendeeName === "string") &&
      (r.revertedAt === undefined || r.revertedAt === null || typeof r.revertedAt === "string") &&
      (r.canMoveBack === undefined || typeof r.canMoveBack === "boolean")
    );
  });
}

export type ParsedRange =
  | { ok: true; rangeStart: string; rangeEnd: string | null }
  | { ok: false; error: string };

/**
 * Validate + normalize a coverage range for the start endpoint (#974). A missing
 * start defaults to `nowIso` (now onward); a missing end is open-ended (null). A
 * given end must be strictly after the start. Both, when present, must be
 * parseable timestamps. Pure so the route and the UI share one rule.
 */
export function parseBulkReassignRange(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  nowIso: string,
): ParsedRange {
  let rangeStart = nowIso;
  if (fromIso != null && fromIso !== "") {
    if (Number.isNaN(Date.parse(fromIso))) return { ok: false, error: "Invalid start date." };
    rangeStart = new Date(fromIso).toISOString();
  }
  let rangeEnd: string | null = null;
  if (toIso != null && toIso !== "") {
    if (Number.isNaN(Date.parse(toIso))) return { ok: false, error: "Invalid end date." };
    rangeEnd = new Date(toIso).toISOString();
    if (Date.parse(rangeEnd) <= Date.parse(rangeStart)) {
      return { ok: false, error: "The end must be after the start." };
    }
  }
  return { ok: true, rangeStart, rangeEnd };
}

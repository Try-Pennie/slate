import type { SelectionOutcome } from "@/lib/booking/core";
import type { Booking, BulkReassignItem, BulkReassignItemStatus, BulkReassignJob } from "@/lib/db/types";

/** The item statuses that stay on the out agent and need a manual force-override
 *  (#974): no covering agent could be placed, or the move exhausted its retries. */
export const ACTIONABLE_ITEM_STATUSES: BulkReassignItemStatus[] = ["unplaceable", "failed"];

/**
 * How many items the bulk-reassign drain processes per tick. Each item does a
 * live verify wave plus a reassign (a Google create + delete), so this is kept
 * modest to stay well under the Worker CPU + subrequest ceiling the cron lanes
 * share (#760); the rest carry over to the next tick (the engine is resumable).
 */
export const BULK_REASSIGN_ITEMS_PER_TICK = 20;

/**
 * How many times a single item may be processed before a transient failure
 * (a reassign error, or a verify outage that never clears) becomes a terminal
 * `failed` instead of retrying forever. A genuinely-full slot is `unplaceable`
 * immediately and does not consume retries.
 */
export const MAX_ITEM_ATTEMPTS = 5;

/** The minimal booking shape the engine's idempotency decisions need. */
export type BookingSnapshot = Pick<Booking, "id" | "status" | "assigned_user_id">;

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
}

/** Every side effect the engine needs; `service.ts` wires the real ones. */
export interface BulkReassignDeps {
  /** The oldest pending items across active jobs, bounded, each with its job. */
  loadPendingItems(limit: number): Promise<{ item: BulkReassignItem; job: BulkReassignJob }[]>;
  /** The booking's current status + assignment, or null if it no longer exists. */
  loadBooking(bookingId: string): Promise<BookingSnapshot | null>;
  /** Live-verified covering-agent selection for this booking (see coverage-target.ts). */
  selectTarget(booking: BookingSnapshot, job: BulkReassignJob): Promise<SelectionOutcome>;
  /** Reassign the booking onto `targetEmail` (adminReassignBooking); throws on failure. */
  reassign(bookingId: string, targetEmail: string, job: BulkReassignJob): Promise<void>;
  /** Persist an item's outcome and its new attempt count in one write. The drain
   *  holds the lane lock, so this serialized write is never raced. */
  commitItemOutcome(itemId: string, outcome: ItemOutcome, attempts: number): Promise<void>;
  /** Flip the job to 'done' if it now has no pending items left. */
  markJobDoneIfDrained(jobId: string): Promise<void>;
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
 * Decide (and, for a move, perform) one item's outcome. Every idempotency
 * decision keys off the booking's CURRENT assignment, which is the source of
 * truth for whether the covering swap has already committed:
 *
 *  - Booking gone / cancelled / completed → `skipped` (never a failure).
 *  - Booking already off the out agent → `moved` WITHOUT reassigning again. This
 *    is the crash-resume guard: if a prior tick committed the swap but died
 *    before marking the item, or someone reassigned the booking externally, the
 *    item is settled from the assignment, never double-moved.
 *  - Otherwise select a live-free, under-cap covering agent and reassign:
 *    a placed move → `moved`; a genuinely-full slot → `unplaceable` (stays on the
 *    out agent for the manual force-override in #974); a verify outage or a
 *    reassign error → retried (`pending`) until `MAX_ITEM_ATTEMPTS`, then `failed`.
 *
 * Does not persist; the drain commits the returned outcome so the write and the
 * attempt increment are one step.
 */
export async function processBulkReassignItem(
  item: BulkReassignItem,
  job: BulkReassignJob,
  deps: BulkReassignDeps,
): Promise<ItemOutcome> {
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

  const selection = await deps.selectTarget(booking, job);
  if (selection.assignment) {
    try {
      await deps.reassign(item.booking_id, selection.assignment.email, job);
      return { status: "moved", targetUserId: selection.assignment.userId, detail: null };
    } catch (err) {
      return retryOrFail(item.attempts, `Reassign failed: ${errMessage(err)}`);
    }
  }
  if (selection.anyUnverified) {
    return retryOrFail(item.attempts, "Calendar verify was unavailable; will retry.");
  }
  return {
    status: "unplaceable",
    targetUserId: null,
    detail: "No agent was free and under their daily cap at the original time.",
  };
}

/**
 * Drain one bounded tick of the bulk-reassign engine. Processes each pending item
 * STRICTLY one at a time (await to completion, commit, then the next) so a
 * committed move is already reflected in the daily-cap count the next item's
 * target selection reads. The caller holds a per-lane lock so no two ticks run
 * concurrently; items left over carry to the next tick (resumable). After the
 * tick, each touched job is checked for completion.
 */
export async function drainBulkReassign(
  deps: BulkReassignDeps,
  limit: number = BULK_REASSIGN_ITEMS_PER_TICK,
): Promise<BulkReassignDrainSummary> {
  const pending = await deps.loadPendingItems(limit);
  const summary: BulkReassignDrainSummary = {
    processed: 0,
    moved: 0,
    unplaceable: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
  };
  const touchedJobs = new Set<string>();
  for (const { item, job } of pending) {
    const outcome = await processBulkReassignItem(item, job, deps);
    await deps.commitItemOutcome(item.id, outcome, item.attempts + 1);
    summary.processed++;
    summary[outcome.status]++;
    touchedJobs.add(job.id);
  }
  for (const jobId of touchedJobs) {
    await deps.markJobDoneIfDrained(jobId);
  }
  return summary;
}

/** A job's per-status item counts for the progress read (#974). */
export interface BulkReassignSummary {
  total: number;
  counts: Record<BulkReassignItemStatus, number>;
  /** True when no item is still pending (mirrors the job-done rule). */
  done: boolean;
}

/** Count a job's items by status for the admin progress view. Pure. */
export function summarizeBulkReassignItems(
  items: { status: BulkReassignItemStatus }[],
): BulkReassignSummary {
  const counts: Record<BulkReassignItemStatus, number> = {
    pending: 0,
    moved: 0,
    unplaceable: 0,
    skipped: 0,
    failed: 0,
  };
  for (const it of items) counts[it.status]++;
  return { total: items.length, counts, done: counts.pending === 0 };
}

/** Minimal booking display context for an actionable item row (#974). */
export interface ActionableBookingContext {
  startsAt: string;
  attendeeName: string | null;
}

/** One actionable ("couldn't place") item for the progress view (#974). */
export interface BulkReassignActionableItem {
  bookingId: string;
  status: BulkReassignItemStatus;
  detail: string | null;
  startsAt: string | null;
  attendeeName: string | null;
}

export interface BulkReassignProgress {
  job: BulkReassignJob;
  summary: BulkReassignSummary;
  /** Unplaceable + failed items, each linkable to the single-reassign force-override. */
  actionable: BulkReassignActionableItem[];
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
): BulkReassignProgress {
  const summary = summarizeBulkReassignItems(items);
  const actionable = items
    .filter((it) => ACTIONABLE_ITEM_STATUSES.includes(it.status))
    .map((it) => ({
      bookingId: it.booking_id,
      status: it.status,
      detail: it.detail,
      startsAt: bookingCtx.get(it.booking_id)?.startsAt ?? null,
      attendeeName: bookingCtx.get(it.booking_id)?.attendeeName ?? null,
    }));
  return { job, summary, actionable };
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

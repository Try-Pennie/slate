/**
 * Moving a rerouted call BACK to its original advisor (#3615). Pure; the IO lives in
 * `demotion-revert-store.ts` and the service wires the reassign.
 *
 * Settled with Dan 2026-10-11: a demotion move is automatic but undoable from the booking's
 * page, and an undone call STAYS with the original advisor. Later demotion sweeps, the demotion
 * decision and the demoted-agent backstop all leave it alone (`pinnedBookingIds`), rather than
 * the next sync moving it again and the backstop paging about it every day.
 *
 * Every refusal is its own reason with its own sentence (L11): each sends the reader somewhere
 * different, and one answering for another is how somebody hunts for a fault that is not there.
 */
import type { BulkReassignItemStatus } from "@/lib/db/types";
import { readDemotionChange, type DemotionChange } from "@/lib/booking/demotion-plan";
import { bookingIsActionable } from "@/lib/booking/detail";
import { parseStampMs } from "@/lib/date/stamp";
import type { AuditEntry } from "@/lib/audit";
import { describeDemotionChange } from "@/lib/booking/demotion-copy";

/** One call a demotion sweep handled, joined with its sweep: what the undo is about. */
export interface DemotionMoveRecord {
  itemId: string;
  bookingId: string;
  jobId: string;
  orgId: string;
  /** The advisor the sweep moved the call OFF: who it goes back to. */
  outUserId: string;
  /** The advisor the sweep moved it TO; null for an item it could not place. */
  toUserId: string | null;
  status: BulkReassignItemStatus;
  /** When the sweep recorded the move (the item's last write). */
  movedAt: string;
  demotionMarkedAt: string;
  change: DemotionChange | null;
  revertedAt: string | null;
  revertedBy: string | null;
}

/** A `bulk_reassign_items` row joined with its sweep, as `demotion-revert-store.ts` reads it. */
export interface DemotionMoveRow {
  id: string;
  booking_id: string;
  status: string;
  target_user_id: string | null;
  updated_at: string;
  reverted_at: string | null;
  reverted_by: string | null;
  bulk_reassign_jobs: {
    id: string;
    org_id: string;
    out_user_id: string;
    demotion_marked_at: string | null;
    demotion_change: unknown;
  } | null;
}

/** The move a row records, or null when the row is not a demotion move at all. The change comes
 *  back from jsonb and goes through the shape check, so a malformed one reads as unrecorded. */
export function demotionMoveFromRow(row: DemotionMoveRow): DemotionMoveRecord | null {
  const job = row.bulk_reassign_jobs;
  if (!job || !job.demotion_marked_at) return null;
  return {
    itemId: row.id,
    bookingId: row.booking_id,
    jobId: job.id,
    orgId: job.org_id,
    outUserId: job.out_user_id,
    toUserId: row.target_user_id,
    status: row.status as BulkReassignItemStatus,
    movedAt: row.updated_at,
    demotionMarkedAt: job.demotion_marked_at,
    change: readDemotionChange(job.demotion_change),
    revertedAt: row.reverted_at,
    revertedBy: row.reverted_by,
  };
}

/** Every reason a move back is refused, as a runtime list so the copy is checked against it. */
export const REVERT_REFUSALS = [
  "no-automatic-move",
  "already-moved-back",
  "moved-since",
  "not-active",
  "already-started",
  "original-left",
] as const;
export type RevertRefusal = (typeof REVERT_REFUSALS)[number];

export type RevertPlan =
  | { kind: "move-back"; toUserId: string; toEmail: string }
  /** The call is already back with the original advisor and only the record is missing (a run
   *  that died between the move and the record). Recording it is the whole remaining work, so the
   *  undo converges instead of refusing. */
  | { kind: "record-only" }
  | { kind: "refused"; reason: RevertRefusal };

/**
 * Decide whether this booking's automatic move can be undone now.
 *
 * The order is the order of what a reader would ask: is there a move to undo, has it already been
 * undone, is the call still the one that moved (still with that advisor, active, upcoming), and
 * can the original advisor take it. A start time that cannot be read is refused as already
 * started, never read as upcoming (L50).
 */
export function planDemotionRevert(input: {
  move: DemotionMoveRecord | null;
  booking: { status: string; assigned_user_id: string | null; starts_at: string };
  original: { email: string | null; deactivated_at: string | null } | null;
  nowMs: number;
}): RevertPlan {
  const { move, booking, original, nowMs } = input;
  if (!move || move.status !== "moved" || !move.toUserId) return { kind: "refused", reason: "no-automatic-move" };
  if (move.revertedAt) return { kind: "refused", reason: "already-moved-back" };
  if (!bookingIsActionable(booking.status)) return { kind: "refused", reason: "not-active" };
  const startsMs = parseStampMs(booking.starts_at);
  if (startsMs === null || startsMs <= nowMs) return { kind: "refused", reason: "already-started" };
  if (booking.assigned_user_id === move.outUserId) return { kind: "record-only" };
  if (booking.assigned_user_id !== move.toUserId) return { kind: "refused", reason: "moved-since" };
  if (!original || original.deactivated_at || !original.email) return { kind: "refused", reason: "original-left" };
  return { kind: "move-back", toUserId: move.outUserId, toEmail: original.email };
}

/** What a refusal says, naming the people it is about. */
export function revertRefusalText(reason: RevertRefusal, names: { original: string; current: string | null }): string {
  switch (reason) {
    case "no-automatic-move":
      return "Slate did not move this call automatically, so there is no automatic move to undo.";
    case "already-moved-back":
      return `This call has already been moved back to ${names.original}.`;
    case "moved-since":
      // `current` is null for a refusal arriving after the page was drawn: who holds the call now
      // is not known there, and the page is redrawn to say it.
      return names.current === null
        ? "This call was moved again after this page loaded, so it was left where it is. The page is being redrawn to show who has it now."
        : `This call has been moved again since, and is now with ${names.current}. Use Reassign if it should go to ${names.original}.`;
    case "not-active":
      return "This call was cancelled or has finished, so there is nothing to move back.";
    case "already-started":
      return "This call's time has already come, so it can no longer be moved.";
    case "original-left":
      return `${names.original} has left Slate, so the call cannot go back to them.`;
  }
}

/**
 * The move a booking's undo is about: the most recent COMPLETED demotion move. A failed or
 * unplaced attempt moved nothing, so it is never the thing to undo.
 */
export function latestDemotionMove(moves: DemotionMoveRecord[]): DemotionMoveRecord | null {
  let best: DemotionMoveRecord | null = null;
  for (const m of moves) {
    if (m.status !== "moved" || !m.toUserId) continue;
    if (!best || Date.parse(m.movedAt) > Date.parse(best.movedAt)) best = m;
  }
  return best;
}

/**
 * The calls an admin moved back, by the advisor they went back to (#3615): pinned to them, so
 * later demotion sweeps, the demotion decision and the demoted-agent backstop leave them alone.
 * The ONE rule all three read, applied to the store's query rows (`pinnedDemotionBookingIds`), so
 * the rule tested here is the rule shipped (L370). A row with no sweep, or not moved back, pins
 * nothing.
 */
export function pinnedByAgent(
  rows: { booking_id: string; reverted_at: string | null; bulk_reassign_jobs: { out_user_id: string } | null }[],
): Map<string, Set<string>> {
  const byAgent = new Map<string, Set<string>>();
  for (const r of rows) {
    const agent = r.bulk_reassign_jobs?.out_user_id;
    if (!agent || !r.reverted_at) continue;
    const set = byAgent.get(agent) ?? new Set<string>();
    set.add(r.booking_id);
    byAgent.set(agent, set);
  }
  return byAgent;
}

/** The detail the move back's reassign carries beside the shared `coverage` reason, so the
 *  booking's history says what this reassign was. */
export const MOVE_BACK_REASON_DETAIL = "Moved back after an automatic reroute";

/** Everything a move back reads and writes, injected so the order is tested without a database. */
export interface MoveBackDeps {
  /** The demotion moves of this booking, scoped to the org (a booking elsewhere has none). */
  loadMoves(bookingId: string, orgId: string): Promise<DemotionMoveRecord[]>;
  /** The booking as it stands now, scoped to the org; null when it is not there. */
  loadBooking(bookingId: string, orgId: string): Promise<{ status: string; assigned_user_id: string | null; starts_at: string } | null>;
  loadUser(userId: string): Promise<{ email: string | null; deactivated_at: string | null } | null>;
  /** The standard admin reassign, so the lead's invite, the calendars and Regal hear about it
   *  the way they hear about every reassign. Throws its own typed refusals (a daily cap, a
   *  calendar clash), which the route already knows how to say. */
  reassign(bookingId: string, toEmail: string, overrideCap: boolean): Promise<void>;
  /** Record the undo, as a compare-and-swap on it not being recorded yet: true only for the call
   *  that recorded it. */
  markReverted(itemId: string, byUserId: string): Promise<boolean>;
  recordAudit(entry: AuditEntry): Promise<void>;
}

export type MoveBackOutcome =
  | { kind: "moved-back"; toUserId: string }
  /** Another press recorded the same undo first; the call is back either way. */
  | { kind: "already-recorded" }
  | { kind: "refused"; reason: RevertRefusal }
  | { kind: "not-found" };

/**
 * Move a rerouted call back to its original advisor (#3615).
 *
 * Safe to run twice at once: the reassign to one advisor is idempotent (#449), and the record is
 * a compare-and-swap, so of two presses exactly one records the undo and writes the audit row.
 * The move goes FIRST and the record after, so a run that dies between them leaves the call back
 * with the advisor and an unrecorded undo, which the planner answers with `record-only` on the
 * next press rather than refusing it. A reassign that refuses records nothing.
 */
export async function moveBackDemotionReroute(
  deps: MoveBackDeps,
  input: {
    bookingId: string;
    orgId: string;
    actor: { userId: string; actingAsUserId?: string | null };
    overrideCap: boolean;
    nowMs: number;
  },
): Promise<MoveBackOutcome> {
  const booking = await deps.loadBooking(input.bookingId, input.orgId);
  if (!booking) return { kind: "not-found" };
  const move = latestDemotionMove(await deps.loadMoves(input.bookingId, input.orgId));
  const original = move ? await deps.loadUser(move.outUserId) : null;
  const plan = planDemotionRevert({ move, booking, original, nowMs: input.nowMs });
  if (plan.kind === "refused") return plan;
  // Narrowed by the planner: a plan that is not refused always has a completed move.
  const m = move as DemotionMoveRecord;
  if (plan.kind === "move-back") await deps.reassign(input.bookingId, plan.toEmail, input.overrideCap);
  if (!(await deps.markReverted(m.itemId, input.actor.userId))) return { kind: "already-recorded" };
  await deps.recordAudit({
    orgId: m.orgId,
    actorId: input.actor.userId,
    action: "booking.demotion_reroute_reverted",
    targetUserId: m.outUserId,
    details: {
      booking_id: input.bookingId,
      job_id: m.jobId,
      item_id: m.itemId,
      from_user_id: m.toUserId,
      to_user_id: m.outUserId,
      ...(input.actor.actingAsUserId ? { acting_as_user_id: input.actor.actingAsUserId } : {}),
      ...(plan.kind === "record-only" ? { recorded_after_the_move: true } : {}),
    },
  });
  return { kind: "moved-back", toUserId: m.outUserId };
}

/**
 * What the booking page shows about an automatic move (#3615), or null when no demotion sweep
 * moved this call. Built here, not in the component, so every sentence is tested and the page
 * holds markup only. Dates are left to the History card below it, which already shows them in
 * the reader's own zone (L605).
 */
export type DemotionMoveView =
  | {
      state: "can-move-back";
      summary: string;
      buttonLabel: string;
      confirmMessage: string;
      confirmLabel: string;
      keepLabel: string;
      overCapText: string;
      /** Every refusal in its own words, for one that arrives after the page was drawn. */
      refusals: Record<RevertRefusal, string>;
    }
  | { state: "moved-back"; summary: string }
  | { state: "cannot"; summary: string; reason: string };

export function demotionMoveView(input: {
  move: DemotionMoveRecord | null;
  booking: { status: string; assigned_user_id: string | null; starts_at: string };
  original: { email: string | null; deactivated_at: string | null } | null;
  nowMs: number;
  nameOf: (userId: string | null) => string;
}): DemotionMoveView | null {
  const { move, booking, nameOf } = input;
  if (!move || move.status !== "moved" || !move.toUserId) return null;
  const original = nameOf(move.outUserId);
  const movedTo = nameOf(move.toUserId);
  const what = describeDemotionChange(move.change) ?? "What changed in Twilio was not recorded.";
  if (move.revertedAt) {
    return {
      state: "moved-back",
      summary: `${nameOf(move.revertedBy)} moved this call back to ${original} after Slate moved it automatically.`,
    };
  }
  const summary = `Slate moved this call from ${original} to ${movedTo} automatically. ${what}`;
  const plan = planDemotionRevert(input);
  if (plan.kind === "refused") {
    return {
      state: "cannot",
      summary,
      reason: revertRefusalText(plan.reason, { original, current: nameOf(booking.assigned_user_id) }),
    };
  }
  const refusals = Object.fromEntries(
    REVERT_REFUSALS.map((r) => [r, revertRefusalText(r, { original, current: null })]),
  ) as Record<RevertRefusal, string>;
  if (plan.kind === "record-only") {
    return {
      state: "can-move-back",
      summary: `This call is back with ${original}, but the move back was not recorded, so Slate could move it again.`,
      buttonLabel: `Record the move back to ${original}`,
      confirmMessage: `Nothing moves: this records that the call belongs with ${original}, so Slate leaves it there.`,
      confirmLabel: "Record it",
      keepLabel: "Not now",
      overCapText: moveBackOverCapText(original),
      refusals,
    };
  }
  return {
    state: "can-move-back",
    summary,
    buttonLabel: `Move back to ${original}`,
    confirmMessage:
      `${original} takes this call again and the lead gets an updated invite; ${movedTo}'s calendar loses it. ` +
      `Slate will then leave the call with ${original}, and will not move it or flag it again.`,
    confirmLabel: "Move back",
    keepLabel: `Keep with ${movedTo}`,
    overCapText: moveBackOverCapText(original),
    refusals,
  };
}

/** The second ask when the original advisor is already at their daily limit. */
export function moveBackOverCapText(original: string): string {
  return `${original} is already at their daily limit of calls on that day. Move the call back anyway?`;
}

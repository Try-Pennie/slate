/**
 * The reschedule commit as one database call (#3265, migration 0171).
 *
 * `commit_reschedule` applies the gated move and writes its outbox work in the same
 * transaction, so a committed reschedule always has a durable record of its slot move
 * and rescheduled webhook. This module is the pure half: the patch mapped onto the
 * function's named arguments, and the answer read back. The service makes the call.
 */
import type { OutboxPayload, OutboxStep } from "../db/types.ts";
import type { BookingUpdate } from "./orchestration.ts";
import { BookingWriteFailedError } from "./gated-write.ts";

/** The arguments `commit_reschedule` takes, named as the function names them. */
export interface CommitRescheduleArgs {
  p_booking_id: string;
  p_guard_assigned: string | null;
  p_guard_event: string | null;
  p_starts_at: string;
  p_ends_at: string;
  p_assigned_user_id: string;
  p_agent_name: string | null;
  p_agent_email: string | null;
  p_gcal_event_id: string;
  p_reschedule_seq: number;
  /** True only when the patch carries a trace: a move that keeps its advisor leaves the stored one. */
  p_set_routing_trace: boolean;
  p_routing_trace: unknown;
  p_steps: OutboxStep[];
  p_payload: OutboxPayload;
}

/**
 * The function's arguments from the move's patch. A field the move must write that is
 * missing is refused by name, because the function would otherwise write a null where
 * a time or an advisor was meant, and the booking would read as moved to nowhere.
 */
export function commitRescheduleArgs(
  bookingId: string,
  patch: BookingUpdate | Record<string, unknown>,
  guard: { assignedUserId: string | null; gcalEventId: string | null },
  outbox: { steps: OutboxStep[]; payload: OutboxPayload },
): CommitRescheduleArgs {
  const p = patch as Record<string, unknown>;
  const required = (key: string): unknown => {
    const v = p[key];
    if (v === undefined || v === null) throw new Error(`commit_reschedule: the move's patch has no ${key}`);
    return v;
  };
  return {
    p_booking_id: bookingId,
    p_guard_assigned: guard.assignedUserId,
    p_guard_event: guard.gcalEventId,
    p_starts_at: String(required("starts_at")),
    p_ends_at: String(required("ends_at")),
    p_assigned_user_id: String(required("assigned_user_id")),
    p_agent_name: (p.agent_name as string | null | undefined) ?? null,
    p_agent_email: (p.agent_email as string | null | undefined) ?? null,
    p_gcal_event_id: String(required("gcal_event_id")),
    p_reschedule_seq: Number(required("reschedule_seq")),
    p_set_routing_trace: p.routing_trace !== undefined,
    p_routing_trace: p.routing_trace ?? null,
    p_steps: outbox.steps,
    p_payload: outbox.payload,
  };
}

/**
 * The function's answer: the outbox row's id when the move applied, or null when the
 * guard matched nothing. A refused call throws as a write failure and is never read as
 * a lost race (#2373), and an answer that is neither is refused by name.
 */
export function readCommitReschedule(result: { data: unknown; error: { message: string } | null }): string | null {
  if (result.error) throw new BookingWriteFailedError("reschedule_commit", result.error.message);
  if (result.data === null || result.data === undefined) return null;
  if (typeof result.data !== "string" || result.data === "") {
    throw new Error(`commit_reschedule answered ${JSON.stringify(result.data)}, which is not an outbox id or null`);
  }
  return result.data;
}

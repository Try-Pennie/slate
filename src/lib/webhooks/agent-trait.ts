import { isRoutable } from "@/lib/routing/staffing-depth";
import { isAgentEvent } from "./events.ts";
import type { AgentBookablePayload, WebhookPayload } from "./types.ts";
import type { WebhookEvent } from "@/lib/db/types";

/**
 * What one send of a delivery states (#2085).
 *
 * A booking event is a fact about the moment it happened, so it is sent exactly
 * as it was recorded, on the first attempt and on every retry.
 *
 * An agent trait is different: it is a STATE, and the delivery path it rides can
 * reorder it. The retry sweep, a manual resend and the dead letter replay all
 * resend a stored payload later than it was recorded, and none of them sends in
 * the order the changes happened. So an agent turned off and back on during a
 * Regal outage would have both deliveries retried, and whichever landed last
 * would decide what Regal believes, with even odds of it being the stale `false`
 * while Slate routes to them.
 *
 * The fix is to make every send state the agent's state AT THAT SEND, read by the
 * stable user id, through the same `isRoutable` predicate routing uses. Then any
 * order of arrival converges on the truth, and a duplicate is harmless. The email
 * Regal is told about stays the one recorded, because that is the profile the
 * trait was addressed to.
 *
 * A read that fails, or finds no row, is a FAILED ATTEMPT carrying the reason,
 * never the recorded value sent blind: the delivery is recorded failed, the retry
 * sweep tries again, and the existing dead letter alerting pages if it never
 * lands, which is the same shape #600 chose for a Regal endpoint with no key.
 */

/** The current state of one agent, or null when no row carries that id. */
export type CurrentRoutableRead = (
  userId: string,
) => Promise<{ bookable: boolean; deactivated_at: string | null } | null>;

export type SendPayloadResult =
  | { ok: true; payload: WebhookPayload }
  | { ok: false; reason: string };

export async function payloadForSend(
  event: WebhookEvent,
  payload: WebhookPayload,
  readCurrent: CurrentRoutableRead,
): Promise<SendPayloadResult> {
  if (!isAgentEvent(event)) return { ok: true, payload };
  const recorded = payload as AgentBookablePayload;
  let current: Awaited<ReturnType<CurrentRoutableRead>>;
  try {
    current = await readCurrent(recorded.user_id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `could not read the agent's current bookable state, so nothing was sent: ${detail}`.slice(0, 1000),
    };
  }
  if (current === null) {
    return {
      ok: false,
      reason: `agent ${recorded.user_id} not found, so nothing was sent`,
    };
  }
  const next: AgentBookablePayload = {
    user_id: recorded.user_id,
    email: recorded.email,
    slate_bookable: isRoutable(current),
  };
  return { ok: true, payload: next };
}

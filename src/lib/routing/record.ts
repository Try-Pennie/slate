import { isMisroute } from "./explain.ts";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Attributes, Criteria, RoutingExclusion, RoutingDecision } from "@/lib/db/types";
import { log } from "@/lib/log";

export { buildRoutingTraceExtras } from "./explain.ts";

export const MISROUTE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/** Input to `recordRoutingDecision`. Exported so it can type the injected
 *  `deps.recordRoutingDecision` seam (#504) without re-declaring the shape. */
export interface RecordRoutingDecisionInput {
  orgId: string;
  bookingId: string | null;
  bucketCode: string;
  bucketId: string | null;
  criteria: Criteria;
  considered: string[];
  excluded: RoutingExclusion[];
  chosenUserId: string | null;
  chosenAttributes: Attributes | null;
  emptyPoolFallback: boolean;
  tierFallback: boolean;
  rungsDropped: number;
  requestedTier: string | null;
  bookedTier: string | null;
  outcome: RoutingDecision["outcome"];
}

/** Persist one routing decision and fire a misroute alert if the chosen agent
 *  fails criteria with no intentional fallback. Best-effort; never throws. */
export async function recordRoutingDecision(input: RecordRoutingDecisionInput): Promise<void> {
  try {
    await supabaseAdmin().from("routing_decisions").insert({
      org_id: input.orgId,
      booking_id: input.bookingId,
      bucket_code: input.bucketCode,
      bucket_id: input.bucketId,
      requested_tier: input.requestedTier,
      booked_tier: input.bookedTier,
      chosen_user_id: input.chosenUserId,
      considered: input.considered,
      excluded: input.excluded,
      empty_pool_fallback: input.emptyPoolFallback,
      tier_fallback: input.tierFallback,
      rungs_dropped: input.rungsDropped,
      outcome: input.outcome,
    });
  } catch (err) {
    log.error("routing", { msg: "routing_decisions insert failed" }, err);
  }

  if (
    input.chosenAttributes &&
    isMisroute({
      chosenAttributes: input.chosenAttributes,
      criteria: input.criteria,
      emptyPoolFallback: input.emptyPoolFallback,
      tierFallback: input.tierFallback,
    })
  ) {
    await sendThrottledAlert(
      `misroute:${input.bucketCode}`,
      MISROUTE_ALERT_COOLDOWN_MS,
      `Slate routing check: booking ${input.bookingId ?? "(none)"} in bucket ${input.bucketCode} went to agent ${input.chosenUserId ?? "(none)"}, who does not match the bucket criteria, and no fallback was applied. This looks like a routing bug; the booking was allowed through. Inspect routing_decisions for this booking.`,
    ).catch(() => {});
  }
}

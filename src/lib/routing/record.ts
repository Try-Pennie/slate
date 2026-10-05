import { isMisroute } from "./explain.ts";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure } from "@/lib/notify/send-failure";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Attributes, Criteria, RoutingExclusion, RoutingDecision, RoutingStageCount } from "@/lib/db/types";
import type { RecordedRefusalStage } from "@/lib/booking/refusal-trace";
import { log } from "@/lib/log";
import { misrouteAlert } from "@/lib/notify/misc-alert-copy";

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
  /** The `xbc` the lead's link actually carried, or null when the caller did not
   *  say (an older embed). Distinct from an empty string, which means the lead
   *  arrived with no code at all (#1908). */
  requestedCode?: string | null;
  /** Whether the catch-all rescued this lead into the Low pool (#1908). */
  catchallApplied?: boolean;
  tierFallback: boolean;
  rungsDropped: number;
  requestedTier: string | null;
  bookedTier: string | null;
  /** #3272, on a refused confirm: the instant asked for, the stage that refused it,
   *  and per rung what each stage left. Absent on a booked decision. */
  requestedStart?: string | null;
  refusalStage?: RecordedRefusalStage | null;
  /** The refused lead's Salesforce lead id, 15 character form, or null (#3276). */
  leadId?: string | null;
  stageCounts?: RoutingStageCount[] | null;
  outcome: RoutingDecision["outcome"];
}

/** Persist one routing decision and fire a misroute alert if the chosen agent
 *  fails criteria with no intentional fallback. Best-effort; never throws. */
export async function recordRoutingDecision(input: RecordRoutingDecisionInput): Promise<void> {
  try {
    // write-ok: the decision log is evidence, not control flow: a refused insert loses one row from the routing report and changes no booking. The report's own count is what would show it.
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
      // #1908: what the lead's link actually carried, and whether the catch-all
      // had to rescue it. Kept as its own column rather than inferred from
      // bucket_code, because a rescued lead and a lead who genuinely asked for the
      // Low pool land in the same bucket and only this tells them apart.
      requested_code: input.requestedCode ?? null,
      catchall_applied: input.catchallApplied ?? false,
      tier_fallback: input.tierFallback,
      rungs_dropped: input.rungsDropped,
      outcome: input.outcome,
      // #3272: null on a booked decision, so the refusal lookup index stays small.
      requested_start: input.requestedStart ?? null,
      refusal_stage: input.refusalStage ?? null,
      stage_counts: input.stageCounts ?? null,
      lead_id: input.leadId ?? null,
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
      misrouteAlert(input.bookingId ?? "(none)", input.bucketCode, input.chosenUserId ?? "(none)"),
    ).catch(logAlertSendFailure(`misroute:${input.bucketCode}`));
  }
}

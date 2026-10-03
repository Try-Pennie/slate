import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import type { ReasonAction } from "@/lib/booking/core";
import { REASON_USAGE_WINDOW_DAYS } from "@/lib/booking/reason-usage-window";

/** Per-action reason_code -> times picked in the window. */
export type ReasonUsageCounts = Record<ReasonAction, Record<string, number>>;

/** Empty usage: no counts. The safe degrade when the read is unavailable, and the
 *  base the parser fills. */
export function emptyReasonUsage(): ReasonUsageCounts {
  return { reschedule: {}, cancel: {}, reassign: {} };
}

/**
 * booking_events.action is PAST tense ("rescheduled"/"cancelled"/"reassigned"),
 * while the reason store and editor key by the present-tense ReasonAction
 * ("reschedule"/"cancel"/"reassign"). The RPC returns the raw event action, so the
 * parser translates it into the reason bucket the UI uses.
 */
const EVENT_ACTION_TO_REASON: Record<string, ReasonAction> = {
  rescheduled: "reschedule",
  cancelled: "cancel",
  reassigned: "reassign",
};

/**
 * Parse the `reason_usage_counts` RPC jsonb (`"<event_action>|<reason_code>" ->
 * count`) into a per-ReasonAction map. Pure. Malformed keys and unmapped actions
 * are dropped rather than throwing, so one odd row never blanks the whole hint.
 */
export function parseReasonUsage(data: unknown): ReasonUsageCounts {
  const out = emptyReasonUsage();
  if (!data || typeof data !== "object") return out;
  for (const [key, n] of Object.entries(data as Record<string, number>)) {
    const sep = key.indexOf("|");
    if (sep === -1) continue;
    const action = EVENT_ACTION_TO_REASON[key.slice(0, sep)];
    if (!action) continue;
    out[action][key.slice(sep + 1)] = n;
  }
  return out;
}

/**
 * How often each reason has been picked in the last `sinceDays` days, from the
 * shared `reason_usage_counts` RPC (#990/#989). Throws on a real read error via
 * `unwrap` (fail-loud, #277) so a broken read is not silently shown as "nothing
 * used"; the caller decides whether to degrade the UI to no hint.
 */
export async function loadReasonUsageCounts(
  sinceDays: number = REASON_USAGE_WINDOW_DAYS,
  now: number = Date.now(),
): Promise<ReasonUsageCounts> {
  const since = new Date(now - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const res = await supabaseAdmin().rpc("reason_usage_counts", { p_since: since });
  return parseReasonUsage(unwrap(res, "reason_usage_counts"));
}

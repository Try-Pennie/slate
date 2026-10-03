import { NextResponse } from "next/server";
import { recordingAlerts } from "@/lib/notify/alert-recording";
import { log } from "@/lib/log";
import { LANE_ALERTED_HEADER } from "./lane-failure";

/**
 * Every deliberate non-ok answer from a cron lane (#3133 follow-up).
 *
 * One failure, one message (Dan, 2026-10-03). The dispatcher pages
 * `cron_lane_failed:<lane>` for a lane that failed, unless the lane's response says
 * it already raised its own alert about it. Which lanes do is not listed anywhere:
 * the lane's own alerting runs inside `ownAlerting`, and whatever alert or failure
 * streak it actually raised there (`alert-recording.ts`) goes back on the response.
 * So a lane that gains its own alert drops the generic page with no other change,
 * and a lane with none keeps it.
 *
 * The cases, each producing exactly one message:
 *
 *   - no `ownAlerting`, or it raised nothing: no header, the generic page fires;
 *   - it paged, or a cooldown held its page back, or it tracked a streak that is
 *     deliberately quiet on a first failure (#486): header set, no generic page;
 *   - it threw BEFORE raising anything (its streak or its send failed): no header,
 *     the generic page fires, so the failure is still said once;
 *   - it threw AFTER raising its alert: header set, because the alert went out.
 *
 * A lane that throws without reaching its catch at all answers Next's own 500 with
 * no header, which is the generic page too.
 *
 * `scripts/test-lane-failure-ownership.ts` refuses a raw 5xx in a cron lane route
 * and an alert raised in a lane's catch outside `ownAlerting`, which is where it
 * would page and also let the generic one through.
 */
export async function laneFailure(
  tag: string,
  error: string,
  ownAlerting?: () => Promise<unknown>,
): Promise<NextResponse> {
  if (!ownAlerting) return laneFailedResponse({ error }, []);
  const recorded = await recordingAlerts(ownAlerting);
  if (!recorded.ok) {
    log.error(tag, { msg: "the lane's own failure alerting threw", alerted: recorded.keys.join(",") }, recorded.error);
  }
  return laneFailedResponse({ error }, recorded.keys);
}

/**
 * The 500 itself, for a lane whose alerting ran somewhere `laneFailure` cannot wrap
 * (it recorded the run with `recordingAlerts` and holds the keys).
 */
export function laneFailedResponse(body: unknown, alertedKeys: readonly string[]): NextResponse {
  const headers: Record<string, string> =
    alertedKeys.length > 0 ? { [LANE_ALERTED_HEADER]: alertedKeys.join(",") } : {};
  return NextResponse.json(body, { status: 500, headers });
}

import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import {
  formatLaneFailureAlert,
  laneFailedKey,
  parseLaneFailure,
  parseTickId,
  LANE_FAILED_COOLDOWN_MS,
  TICK_ID_HEADER,
} from "@/lib/monitor/lane-failure";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Where the Worker's cron dispatcher reports a lane that threw or answered non-ok
 * on its scheduled run (#3133). Not a lane itself and never scheduled: the
 * dispatcher calls it in process, only on a failure, with the cron bearer.
 *
 * The send happens HERE rather than in `worker/index.ts` so it uses the app's own
 * Supabase client and environment, exactly as every other alert does. A send that
 * fails answers 500, which the dispatcher logs against the tick, so a lane failure
 * that could not be paged about is still on the record beside the failure itself.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const report = parseLaneFailure(await req.json().catch(() => null));
  if (!report) {
    return NextResponse.json({ error: "not a lane failure report" }, { status: 400 });
  }
  const tickId = parseTickId(req.headers.get(TICK_ID_HEADER));
  const key = laneFailedKey(report.lane);
  try {
    // alert-key: cron_lane_failed:*
    await sendThrottledAlert(key, LANE_FAILED_COOLDOWN_MS, formatLaneFailureAlert(report, tickId));
  } catch (err) {
    log.error("cron", { msg: "lane failure alert not sent", key, tick: tickId }, err);
    return NextResponse.json({ error: "alert not sent" }, { status: 500 });
  }
  return NextResponse.json({ reported: key });
}

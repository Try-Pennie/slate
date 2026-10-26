import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { runBusyMinutesLane } from "@/lib/monitor/busy-minutes-lane";
import { log } from "@/lib/log";
import { laneFailure } from "@/lib/monitor/lane-failure-response";

export const dynamic = "force-dynamic";

/**
 * BUSY MINUTES lane (#3124): once a day, has a minute holding more than a tenth of the
 * booking load run's bar (8 or more at 70) happened on 3 of the last 7 days? Until
 * cutover it adds cal.com's routed responses to Slate's routed bookings minute by
 * minute.
 *
 * Fired at 05:41 and 09:41 UTC (worker/cron-routes.ts); the second stands down when
 * the first reached a verdict. The reads, the judgement, the alerts and the verdict
 * stamp live in `lib/monitor/busy-minutes-lane.ts`. A run that could not count answers
 * 200 with `status: "unmeasured"`: it is a handled outcome with its own page
 * (`load_bar_unread`, on the day's last attempt), not a lane failure. The verdict stamp
 * is this lane's only heartbeat, so a run that measured nothing goes stale exactly as
 * one that never fired.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/busy-minutes");
  if (claimed) return claimed;
  try {
    return NextResponse.json(await runBusyMinutesLane());
  } catch (err) {
    log.error("busy-minutes", { msg: "cron failed" }, err);
    return laneFailure("busy-minutes", err instanceof Error ? err.message : String(err));
  }
}

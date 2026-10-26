import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { runAdvisorPhotoLane } from "@/lib/advisor-photos/lane";
import { log } from "@/lib/log";
import { laneFailedResponse, laneFailure } from "@/lib/monitor/lane-failure-response";

export const dynamic = "force-dynamic";

/**
 * ADVISOR PHOTOS lane (#3027): read every active person's photo from the Google
 * Workspace directory, as `DIRECTORY_ADMIN_SUBJECT`, and keep the bytes in
 * `advisor_photos` for Slate to serve from its own origin.
 *
 * Fired at 04:17 and 10:17 UTC (worker/cron-routes.ts); the second stands down
 * when the first reached a verdict. All the work, the lock, the alerts and the
 * verdict stamp live in `lib/advisor-photos/lane.ts`, which the admin's manual
 * trigger shares, so the two cannot drift. The verdict stamp is this lane's only
 * heartbeat: a run that measured nothing is as much a stopped lane as one that
 * never fired, and `verdict:advisor-photos` goes stale on both.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/advisor-photos");
  if (claimed) return claimed;
  try {
    const result = await runAdvisorPhotoLane("cron");
    if (result.status === "measured") {
      // Counts only: the plan carries image bytes and addresses, neither of which
      // belongs in a cron response body.
      return NextResponse.json({ status: result.status, verdict: result.verdict, counts: result.plan.counts });
    }
    // The lane pages about its own failure from inside the run, and the failed
    // result names exactly the alerts raised ABOUT that failure (recorded around
    // that page alone in lib/advisor-photos/lane.ts). Nothing else the run raised
    // counts, so an unrelated page cannot silence the generic one.
    if (result.status === "failed") return laneFailedResponse(result, result.alerted);
    return NextResponse.json(result);
  } catch (err) {
    log.error("advisor-photos", { msg: "cron failed" }, err);
    return laneFailure("advisor-photos", err instanceof Error ? err.message : String(err));
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { runAdvisorPhotoLane } from "@/lib/advisor-photos/lane";
import { log } from "@/lib/log";
import { recordingAlerts } from "@/lib/notify/alert-recording";
import { laneFailedResponse } from "@/lib/monitor/lane-failure-response";

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
  if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });
  // The lane pages about its own failure from inside the run (lib/advisor-photos/
  // lane.ts), so the run is recorded and whatever it raised goes back on a failed
  // response: one failure, one message, with no list of which lanes alert.
  const run = await recordingAlerts(() => runAdvisorPhotoLane("cron"));
  if (!run.ok) {
    log.error("advisor-photos", { msg: "cron failed" }, run.error);
    const message = run.error instanceof Error ? run.error.message : String(run.error);
    return laneFailedResponse({ error: message }, run.keys);
  }
  const result = run.value;
  if (result.status === "measured") {
    // Counts only: the plan carries image bytes and addresses, neither of which
    // belongs in a cron response body.
    return NextResponse.json({ status: result.status, verdict: result.verdict, counts: result.plan.counts });
  }
  if (result.status === "failed") return laneFailedResponse(result, run.keys);
  return NextResponse.json(result);
}

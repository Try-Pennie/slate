import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { runAdvisorPhotoLane } from "@/lib/advisor-photos/lane";
import { log } from "@/lib/log";

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
  try {
    const result = await runAdvisorPhotoLane("cron");
    if (result.status === "measured") {
      // Counts only: the plan carries image bytes and addresses, neither of which
      // belongs in a cron response body.
      return NextResponse.json({ status: result.status, verdict: result.verdict, counts: result.plan.counts });
    }
    return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
  } catch (err) {
    log.error("advisor-photos", { msg: "cron failed" }, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

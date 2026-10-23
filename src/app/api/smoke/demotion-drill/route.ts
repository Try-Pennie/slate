import { NextResponse, type NextRequest } from "next/server";
import { refuseBearerAuth } from "@/lib/bearer-failure";
import { authenticateBearer, CANARY_CALLERS } from "@/lib/booking/api-auth";
import { configuredBookingApiKeys } from "@/lib/booking/api-keys";
import { acquireLock, releaseLock } from "@/lib/locks";
import { runDemotionDrillLive } from "@/lib/booking/demotion-drill-live";
import type { DrillReason } from "@/lib/booking/demotion-drill";
import { releaseTestAdvisorLease, takeTestAdvisorLease } from "@/lib/booking/test-advisor-lease";
import { shortErrorReason } from "@/lib/notify/error-text";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/** One drill at a time: two would book and demote the same two test advisors at once. Longer
 *  than the drill can take, its sweep drain waiting on the lane included. */
const DRILL_LOCK_KEY = "demotion_drill";
const DRILL_LOCK_TTL_MS = 5 * 60_000;

/**
 * The reroute drill's one step inside the deployment (#3615), for `pnpm verify:reroute-on-ineligibility`.
 *
 * The drill books, moves and cancels a real test call, which needs Slate's own calendar
 * credentials, and those live in the Worker rather than in GitHub. So the daily workflow calls
 * this, and this runs the drill (`demotion-drill-live.ts`) and answers its verdict.
 *
 * WHO MAY CALL IT: the canary's own Bearer key, the same contract as its `/api/smoke` siblings:
 * 503 when none is configured, 401 for any other key, a partner's included.
 *
 * WHAT IT MAY TOUCH: the DRILL test bucket and the two smoke test advisors, fixed in code and never
 * taken from the request. Nothing about it can be pointed at a real advisor or a real lead. It
 * holds the one lease over those advisors for its run (#4180), so the smoke canary never books on
 * them at the same time; while the canary holds it, this answers `test-advisors-held`.
 *
 * Every verdict answers 200 with the drill's own `reason`, a failed drill included, because the
 * command maps each reason to its own exit code; an HTTP error would collapse them into one (L11).
 */
export async function POST(req: NextRequest) {
  const keys = configuredBookingApiKeys(CANARY_CALLERS);
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return refuseBearerAuth(req.headers, auth);
  }

  // lock-overlap: refused. A second drill while one runs answers `busy` and touches nothing, because
  // two would book and demote the same two test advisors at once. The TTL outlasts the drill, its
  // wait on the drain lane included, so it cannot lapse under a drill still running.
  const claim = await acquireLock(DRILL_LOCK_KEY, DRILL_LOCK_TTL_MS);
  if (claim === null) {
    return NextResponse.json({ reason: "busy", detail: "Another reroute drill is running, so this one did not start." });
  }
  // #4180: the smoke canary's full pass books on the same two test advisors. While it holds them
  // the drill does not start, and answers so; its command asks again until its bound and then
  // reports the run as not measured, never as the did-not-move a collision used to cause.
  let advisors: string | null = null;
  try {
    advisors = await takeTestAdvisorLease();
    if (advisors === null) {
      return NextResponse.json({
        reason: "test-advisors-held",
        detail: "The smoke test advisors are held by another run (usually the smoke canary), so the drill did not start.",
      } satisfies { reason: DrillReason; detail: string });
    }
    return NextResponse.json(await runDemotionDrillLive());
  } catch (err) {
    log.error("demotion-drill", { msg: "the drill threw past its own boundary" }, err);
    return NextResponse.json({ reason: "errored", detail: `The drill could not run: ${shortErrorReason(err)}` });
  } finally {
    if (advisors !== null) await releaseTestAdvisorLease(advisors);
    await releaseLock(DRILL_LOCK_KEY, claim);
  }
}

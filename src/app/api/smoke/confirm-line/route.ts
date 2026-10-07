import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { refuseBearerAuth } from "@/lib/bearer-failure";
import { authenticateBearer, CANARY_CALLERS } from "@/lib/booking/api-auth";
import { configuredBookingApiKeys } from "@/lib/booking/api-keys";
import { CONFIRM_LINE_BINDING } from "@/lib/booking/confirm-line-object";
import { durableGroupingDirectory, durableLineNamespace, type DurableLineNamespace } from "@/lib/booking/shared-confirm-line";
import { realSleep, realTimer } from "@/lib/read-within-deadline";
import {
  CONFIRM_LINE_CHECKS,
  CONFIRM_LINE_PROBE_REASON,
  CONFIRM_LINE_VERIFY_GROUP,
  runConfirmLineProbe,
} from "@/lib/monitor/confirm-line-probe";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * The hand that reaches the shared confirm line for `pnpm verify:confirm-line` (#3340).
 *
 * A Durable Object is reachable only through a binding inside the Worker, so a command
 * run from a laptop or a GitHub runner cannot ask it anything directly. This endpoint runs
 * the probe (`src/lib/monitor/confirm-line-probe.ts`) here, with the confirm path's own
 * client and its own transport, and answers with each check's outcome.
 *
 * WHO MAY CALL IT: the canary's own Bearer key, exactly as `/api/smoke/burst-counter`
 * and `/api/smoke/heartbeat` (#2645, #2854), so this needs no new secret. Fails CLOSED
 * with 503 when no key is configured; 401 for a wrong or missing one.
 *
 * WHAT IT MAY TOUCH: the verification group's object only, and fresh instants within it
 * that the probe mints per run. Nothing is read from the request, and that is a security
 * property rather than tidiness: a caller who could name a group or an instant could put a
 * phantom leader in front of real confirms, or hand a real follower a "taken" it never
 * earned. There is no parameter to add later without re-reading this comment.
 *
 * It never reads the stored switch. The switch decides whether REAL confirms use the
 * shared line; whether the object answers is a separate question, and it matters most
 * while the switch is still off and nothing else is asking.
 *
 * WHAT IT CANNOT PROVE: every participant runs in this one invocation, so a pass shows the
 * object answers and keeps the line's rules, and cannot show that two isolates reach the
 * same object. Only a load run can. What it CAN prove since #3481 is that the directory
 * survives the platform's hibernation: the probe's own directory sleeps on the platform's
 * clock, not ours, and is read back from storage.
 */
export async function POST(req: NextRequest) {
  const callers = configuredBookingApiKeys(CANARY_CALLERS);
  const auth = authenticateBearer(req.headers.get("authorization"), callers);
  if (!auth.ok) {
    return refuseBearerAuth(req.headers, auth);
  }

  let bindings: Record<string, unknown> | null;
  try {
    bindings = getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch {
    bindings = null;
  }
  // Two different findings with two different remedies (L11): a context that could not
  // be read never looked for the object at all, which is also what a dev server answers.
  if (!bindings) return NextResponse.json({ reason: CONFIRM_LINE_PROBE_REASON.contextUnreadable }, { status: 503 });
  const lineObjects = bindings[CONFIRM_LINE_BINDING] as DurableLineNamespace | undefined;
  if (!lineObjects) return NextResponse.json({ reason: CONFIRM_LINE_PROBE_REASON.bindingMissing }, { status: 503 });

  const checks = await runConfirmLineProbe({
    namespace: durableLineNamespace(lineObjects),
    // #3460: the pool grouping directory, through the same binding and the production
    // directory transport. The probe writes only its own verification directory and
    // only reads the live one; no name comes from the request.
    directory: (name) => durableGroupingDirectory(lineObjects).directory(name),
    now: () => Date.now(),
    timer: realTimer,
    // #3481: the wake check leaves its own directory idle for whole spells on the real
    // clock, so a healthy run holds this request about twenty seconds longer. An HTTP
    // invocation has no wall time limit while its caller is connected, and the command
    // waits `REPLY_DEADLINE_MS` for it.
    sleep: realSleep,
    newId: () => crypto.randomUUID(),
  });
  const failed = CONFIRM_LINE_CHECKS.filter((c) => checks[c].outcome !== "passed");
  if (failed.length > 0) {
    log.warn("confirm-line-probe", {
      msg: "the shared confirm line did not answer as its rules say",
      ...Object.fromEntries(failed.map((c) => [c, checks[c].outcome])),
    });
  }
  return NextResponse.json({ reason: CONFIRM_LINE_PROBE_REASON.checked, group: CONFIRM_LINE_VERIFY_GROUP, checks });
}

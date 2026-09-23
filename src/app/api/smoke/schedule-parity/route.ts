import { NextResponse, type NextRequest } from "next/server";
import { authenticateBearer, CANARY_CALLERS } from "@/lib/booking/api-auth";
import { configuredBookingApiKeys } from "@/lib/booking/api-keys";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { loadMonitorSettings } from "@/lib/monitor/settings";
import {
  parseParitySweep,
  classifyParitySweep,
  buildScheduleParityAlert,
  buildScheduleParityAllClear,
} from "@/lib/monitor/schedule-parity-alert";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Where the daily Slate against cal.com comparison reports its result (#2031).
 *
 * The sweep itself cannot run here. It is roughly one cal.com read per agent, about
 * a hundred subrequests, and the four cron lanes share one Worker invocation budget
 * the recompute lane is already running at 100 to 120 percent of (#2022). So it runs
 * on a GitHub schedule, and this is the one step back into the app.
 *
 * WHY it comes back at all, rather than the workflow posting to Slack itself like
 * the smoke canary does: drift is a CONDITION, not an event. It stays true until
 * somebody corrects one side, so the reader needs to be told when it is over, and it
 * must not repeat every morning while it sits. Both of those need a memory of what
 * was said yesterday, and a GitHub runner has none. `alert_state` does, and coming
 * through the app's own dispatcher also means one cooldown anybody can tune on the
 * settings screen, one catalog classification, and the copy rendering in
 * `pnpm preview:alerts` like every other alert.
 *
 * WHO MAY CALL IT: the booking API Bearer key, the same key the smoke canary already
 * holds, so this needs no new secret. Fails CLOSED with 503 when no key is
 * configured, 401 for a wrong or missing one. Same contract as its siblings
 * `/api/smoke/version`, `/api/smoke/heartbeat` and `/api/smoke/burst-counter`.
 *
 * WHAT IT MAY TOUCH: one alert key, `schedule_parity_drift`, which is a constant
 * here and is never taken from the request. The body carries COUNTS and verdict
 * names, and a verdict outside the fourteen the sweep can produce is refused rather
 * than rendered (`parseParitySweep`), so a key holder cannot put words of their own
 * into a message somebody reads on a phone and acts on. The run link may only point
 * at GitHub, for the same reason.
 *
 * It deliberately stamps NO heartbeat. The caller stamps that only after this
 * answers `page` or `all-clear`, so a sweep that ran faithfully and learned nothing
 * leaves the lane to go stale rather than reporting itself alive: a detector that
 * has stopped concluding looks exactly like one finding nothing wrong (#1394).
 */
const PARITY_ALERT_KEY = "schedule_parity_drift";

export async function POST(req: NextRequest) {
  // #2645: the canary's own key (and the legacy shared pair) only, never a partner's.
  const keys = configuredBookingApiKeys(CANARY_CALLERS);
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }

  const sweep = parseParitySweep(body);
  if ("error" in sweep) {
    return NextResponse.json({ error: sweep.error }, { status: 400 });
  }

  const judgement = classifyParitySweep(sweep);
  log.info("schedule-parity", {
    msg: "sweep reported",
    action: judgement.action,
    total: judgement.total,
    compared: judgement.compared,
    drifted: judgement.drifted,
    standing: judgement.standing,
    unmeasured: judgement.unmeasured,
  });

  // An unmeasured sweep settles nothing in EITHER direction. It may not page,
  // because it found no difference, and it may not clear, because it looked at
  // nobody: an all clear hung off "we did not alert this run" is how a recovery
  // notice gets posted from a query that never ran (#1134, #1152).
  if (judgement.action === "unmeasured") {
    return NextResponse.json({ action: judgement.action, compared: judgement.compared });
  }

  if (judgement.action === "page") {
    const settings = await loadMonitorSettings();
    await sendThrottledAlert(
      PARITY_ALERT_KEY,
      settings.cooldownMs.schedule_parity_drift,
      buildScheduleParityAlert(judgement),
    );
  } else {
    await resolveAlert(PARITY_ALERT_KEY, buildScheduleParityAllClear(judgement));
  }

  return NextResponse.json({
    action: judgement.action,
    compared: judgement.compared,
    drifted: judgement.drifted,
  });
}

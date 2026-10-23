import { NextResponse, type NextRequest } from "next/server";
import { refuseBearerAuth } from "@/lib/bearer-failure";
import { authenticateBearer, CANARY_CALLERS } from "@/lib/booking/api-auth";
import { configuredBookingApiKeys } from "@/lib/booking/api-keys";
import { resolveRecovered, sendThrottledAlert, type SendOutcome } from "@/lib/notify/dispatch";
import { CONDITION_REPEAT_MS } from "@/lib/notify/repeat-policy";
import { clearFailureStreak, trackConsecutiveStreak } from "@/lib/notify/streak";
import {
  FULL_FAILURE_STREAK_KEY,
  FULL_FAILURE_STREAK_WINDOW_S,
  formatSmokeCanaryRecovery,
  fullFailureWaits,
  keysClearedBy,
  parseSmokeReport,
  smokeCanaryFailedKey,
  smokeFailureSubjects,
  type SmokeMode,
} from "@/lib/monitor/smoke-canary-failure";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * The smoke canary's run outcome, handed over by `.github/workflows/smoke-canary.yml`
 * (#3801) so its failure posts through the Worker's alert throttle rather than on
 * every failing run.
 *
 * - `failed`: post the message the workflow built, on `smoke_canary_failed:<mode>`,
 *   at once when a check is newly failing and otherwise once a day. Answers what the
 *   send did, and the workflow posts directly itself unless that is `sent`, `held` or `waiting`.
 * - `passed`: a clean run, so the matching failure (both, for a full pass) clears with
 *   an all-clear, but only if one was posted.
 * - #1493: a FULL pass failure is counted, and between 9pm and 8am ET the first of a
 *   run is held and answered `waiting`, so the workflow does not post it either; the
 *   second in a row posts. A count that cannot be read posts. A clean full pass
 *   clears the count.
 *
 * Who may call: the canary's own key only (`CANARY_CALLERS`), as on the heartbeat
 * route beside it, so a partner's key is refused. Fails CLOSED with no key
 * configured. Whose data: it reads and writes only the two `smoke_canary_failed`
 * rows of `alert_state` and the one `smoke_canary_full_failures` row of
 * `rate_limits`, and posts to the alerts channel; nothing else is reachable.
 * The text is bounded and cannot mention a whole channel.
 */
export async function POST(req: NextRequest) {
  const keys = configuredBookingApiKeys(CANARY_CALLERS);
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return refuseBearerAuth(req.headers, auth);
  }
  const body = await req.json().catch(() => null);
  const parsed = parseSmokeReport(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const report = parsed.report;

  if (report.outcome === "passed") {
    if (report.mode === "full") await clearFailureStreak(FULL_FAILURE_STREAK_KEY);
    // alert-key: smoke_canary_failed:*
    const cleared = await resolveRecovered(
      keysClearedBy(report.mode).map((key) => ({
        key,
        text: formatSmokeCanaryRecovery(key.slice(key.indexOf(":") + 1) as SmokeMode),
      })),
    );
    return NextResponse.json({ ok: true, cleared });
  }

  if (report.mode === "full") {
    const streak = await trackConsecutiveStreak(FULL_FAILURE_STREAK_KEY, FULL_FAILURE_STREAK_WINDOW_S, 2);
    if (fullFailureWaits(Date.now(), streak)) {
      log.info("smoke-failure", { msg: "first overnight full pass failure held", mode: report.mode });
      return NextResponse.json({ ok: true, outcome: "waiting" });
    }
  }

  try {
    // A send that returned without reporting is read as not posted, so the workflow
    // posts directly: the loud side.
    let outcome: SendOutcome = "skipped";
    // alert-key: smoke_canary_failed:*
    // alert-text-ok: the message the canary's own alerter built from its failure log,
    // bounded, never a raw error. A mention in it is made inert where every message is
    // sent (src/lib/notify/slack.ts, #3528), not here.
    await sendThrottledAlert(smokeCanaryFailedKey(report.mode), CONDITION_REPEAT_MS, report.text, {
      subjects: smokeFailureSubjects(report.checks),
      onOutcome: (o) => {
        outcome = o;
      },
    });
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    // The workflow posts directly on anything but sent, held or waiting, so a throw here costs
    // one direct post, never silence.
    log.error("smoke-failure", { msg: "canary failure handoff could not be posted", mode: report.mode }, err);
    return NextResponse.json({ ok: false, outcome: "failed" }, { status: 500 });
  }
}

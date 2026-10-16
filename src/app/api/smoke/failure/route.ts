import { NextResponse, type NextRequest } from "next/server";
import { refuseBearerAuth } from "@/lib/bearer-failure";
import { authenticateBearer, CANARY_CALLERS } from "@/lib/booking/api-auth";
import { configuredBookingApiKeys } from "@/lib/booking/api-keys";
import { resolveRecovered, sendThrottledAlert, type SendOutcome } from "@/lib/notify/dispatch";
import { CONDITION_REPEAT_MS } from "@/lib/notify/repeat-policy";
import {
  formatSmokeCanaryRecovery,
  keysClearedBy,
  parseSmokeReport,
  smokeCanaryFailedKey,
  smokeFailureSubjects,
  withoutBroadcastMentions,
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
 *   send did, and the workflow posts directly itself unless that is `sent` or `held`.
 * - `passed`: a clean run, so the matching failure (both, for a full pass) clears with
 *   an all-clear, but only if one was posted.
 *
 * Who may call: the canary's own key only (`CANARY_CALLERS`), as on the heartbeat
 * route beside it, so a partner's key is refused. Fails CLOSED with no key
 * configured. Whose data: it reads and writes only the two `smoke_canary_failed`
 * rows of `alert_state` and posts to the alerts channel; nothing else is reachable.
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
    // alert-key: smoke_canary_failed:*
    const cleared = await resolveRecovered(
      keysClearedBy(report.mode).map((key) => ({
        key,
        text: formatSmokeCanaryRecovery(key.slice(key.indexOf(":") + 1) as SmokeMode),
      })),
    );
    return NextResponse.json({ ok: true, cleared });
  }

  try {
    // A send that returned without reporting is read as not posted, so the workflow
    // posts directly: the loud side.
    let outcome: SendOutcome = "skipped";
    // alert-key: smoke_canary_failed:*
    // alert-text-ok: the message the canary's own alerter built from its failure log,
    // bounded and stripped of channel mentions, never a raw error.
    await sendThrottledAlert(smokeCanaryFailedKey(report.mode), CONDITION_REPEAT_MS, withoutBroadcastMentions(report.text), {
      subjects: smokeFailureSubjects(report.checks),
      onOutcome: (o) => {
        outcome = o;
      },
    });
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    // The workflow posts directly on anything but sent or held, so a throw here costs
    // one direct post, never silence.
    log.error("smoke-failure", { msg: "canary failure handoff could not be posted", mode: report.mode }, err);
    return NextResponse.json({ ok: false, outcome: "failed" }, { status: 500 });
  }
}

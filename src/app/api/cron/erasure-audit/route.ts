import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { auditSnowflakeErasures } from "@/lib/snowflake/erasure-audit";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 120_000;
// One re-page per run at most for a persistent residual, not spam. Matches the
// co-scheduled reconcile lane's 6h cadence.
const ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Erasure content-audit lane (#1103 Workstream C). The Snowflake half of a DSR
 * erasure is a manual operator step, and the count reconcile can't see whether it
 * happened (a redacted and a full-fidelity row count the same). This lane reads
 * the pii.erasure audit trail and Slack-alerts if the warehouse still holds contact
 * PII for an erased booking. Co-scheduled with snowflake-reconcile on the 6h lane
 * (own lock), so if that lane stops firing, reconcile's dead-man's switch pages.
 * Fail-loud (log.error + 500). No-op while the mirror is unconfigured.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });

  const lock = await acquireLock("cron_erasure_audit", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });

  try {
    const result = await auditSnowflakeErasures();
    if (!result.skipped && !result.ok) {
      await sendThrottledAlert(
        "snowflake_erasure_residual",
        ALERT_COOLDOWN_MS,
        `Slate: a data-subject erasure is incomplete in the Snowflake warehouse. ${result.reasons.join("; ")}. Run the Snowflake purge step in docs/pii-erasure-runbook.md for the affected bookings.`,
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("erasure-audit", { msg: "cron failed", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseLock("cron_erasure_audit", lock);
  }
}

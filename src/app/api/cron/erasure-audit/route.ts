import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { auditSnowflakeErasures } from "@/lib/snowflake/erasure-audit";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { log } from "@/lib/log";
import { erasureResidualAlert, erasureResidualRecovery } from "@/lib/snowflake/alert-copy";

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
 * PII for an erased booking. Co-scheduled with snowflake-reconcile on the 6h lane,
 * under its own lock. Fail-loud (log.error + 500). No-op while the mirror is
 * unconfigured.
 *
 * Stamps its OWN heartbeat (#1123), judged against MIRROR_STALE_BOUNDS_MS. This was
 * previously documented as covered by the co-scheduled reconcile lane's dead-man's
 * switch, which was wrong twice over: reconcile's heartbeat was watched by no bound
 * at all, and even working it could not have covered this lane, because reconcile
 * succeeding keeps ITS stamp fresh while this route errors every run. A safety net
 * failing in silence is worse than no safety net. The stamp happens only on a
 * completed run (the error path returns before it), which is exactly what lets the
 * watchdog see a persistently broken audit.
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
        erasureResidualAlert(result.reasons),
      );
    } else if (!result.skipped) {
      // #1151: an incomplete erasure is a CONDITION that ends when the operator
      // runs the purge, and this audit is the only thing that would ever notice.
      // Hung off the MEASURED clean result: a skipped run (mirror unconfigured)
      // checked nothing and must not clear a real page.
      const cleared = await resolveAlert(
        "snowflake_erasure_residual",
        erasureResidualRecovery(),
      );
      if (cleared) log.info("erasure-audit", { msg: "residual alert cleared" });
    }
    await recordHeartbeat("erasure-audit").catch(() => {});
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("erasure-audit", { msg: "cron failed", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseLock("cron_erasure_audit", lock);
  }
}

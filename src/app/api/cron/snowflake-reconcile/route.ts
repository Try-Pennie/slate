import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { reconcileSnowflakeMirror } from "@/lib/snowflake/reconcile";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 120_000;
// Matches the 6h cadence: a persistent drift should re-page at most once per run,
// not spam, but a fault that clears is re-checked next run.
const ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Snowflake mirror reconciliation lane (#1101). Counts every mirrored table in
 * Supabase vs Snowflake, runs a positive control, and Slack-alerts on drift or a
 * failed control. Its own cron expression + lock. Fail-loud (log.error + 500).
 * No-op while the mirror is unconfigured.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });

  const lock = await acquireLock("cron_snowflake_reconcile", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });

  try {
    const result = await reconcileSnowflakeMirror();
    if (!result.skipped && !result.ok) {
      await sendThrottledAlert(
        "snowflake_reconcile_drift",
        ALERT_COOLDOWN_MS,
        `Slate: the Snowflake analytics mirror is out of sync with the live database. ${result.reasons.join("; ")}. The export lane may be lagging or failing; deletion (when built) must not run until this clears.`,
      );
    }
    await recordHeartbeat("snowflake-reconcile").catch(() => {});
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("snowflake-reconcile", { msg: "cron failed", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseLock("cron_snowflake_reconcile", lock);
  }
}

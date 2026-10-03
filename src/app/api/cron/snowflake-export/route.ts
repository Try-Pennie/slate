import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { acquireLock, releaseLock } from "@/lib/locks";
import { runSnowflakeExport } from "@/lib/snowflake/export";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

// Longer than the export's 60s wall-time budget so the lock is never released
// mid-run and a slow tick can't overlap itself.
const LOCK_TTL_MS = 120_000;

/**
 * Snowflake archival mirror export lane (#1099). Its OWN cron expression + lock
 * (cron_snowflake_export), never co-scheduled, so it gets its own CPU/subrequest
 * budget. A no-op while the mirror is unconfigured. Fails loud (log.error + 500)
 * so a table failure surfaces instead of a silently stale warehouse.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }

  const lock = await acquireLock("cron_snowflake_export", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });

  try {
    const result = await runSnowflakeExport();
    // Dead-man's switch (#1101): stamp only on a successful tick so the
    // lane-watchdog pages if the export goes silently quiet. Best-effort.
    await recordHeartbeat("snowflake-export").catch(() => {});
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("snowflake-export", { msg: "cron failed", error: message });
    return laneFailure("snowflake-export", message);
  } finally {
    await releaseLock("cron_snowflake_export", lock);
  }
}

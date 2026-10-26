import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLease, releaseLock } from "@/lib/locks";
import { runSnowflakeExport } from "@/lib/snowflake/export";
import { leaseHeldThroughout } from "@/lib/monitor/lease-heartbeat";
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
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/snowflake-export");
  if (claimed) return claimed;

  // lock-overlap: fenced. One MERGE can outlast the TTL, and the MERGE overwrites by
  // id with no recency check, so a stale batch from an overrunning run could land
  // over a newer run's. The lease renews before each MERGE and stops the run once
  // another holds the key (#3120).
  const lease = await acquireLease("cron_snowflake_export", LOCK_TTL_MS);
  if (!lease) return NextResponse.json({ skipped: "overlapping-run" });

  try {
    const result = await runSnowflakeExport({ stillHeld: lease.stillHeld });
    // Dead-man's switch (#1101): stamp only on a successful tick so the
    // lane-watchdog pages if the export goes silently quiet. Best-effort.
    // #3120: withheld when the lease was lost part way, so the gap pages.
    if (leaseHeldThroughout(lease, "snowflake-export")) await recordHeartbeat("snowflake-export").catch(() => {});
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("snowflake-export", { msg: "cron failed", error: message });
    return laneFailure("snowflake-export", message);
  } finally {
    await releaseLock("cron_snowflake_export", lease.token());
  }
}

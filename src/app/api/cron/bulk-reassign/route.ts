import { NextResponse, type NextRequest } from "next/server";
import { drainBulkReassignJobs } from "@/lib/booking/service";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { CRON_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { acquireLock, releaseLock } from "@/lib/locks";
import { log } from "@/lib/log";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";

export const dynamic = "force-dynamic";

/**
 * Bulk coverage-reassign drain lane (#973, #562). Moves an out agent's upcoming
 * bookings onto live-verified covering agents, one at a time, bounded per tick.
 * Its OWN lock so two overlapping ticks can never process the same item twice
 * (the engine also keys idempotency off the booking's assignment, so a lost lock
 * can't double-move either). NOT drained through the generic non-serial outbox:
 * the serialization is what keeps the daily-cap count each pick sees current.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }

  const lock = await acquireLock("cron_bulk_reassign", CRON_LOCK_TTL_MS);
  if (!lock) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    const summary = await drainBulkReassignJobs().catch((err) => {
      log.error("bulk-reassign", { msg: "drain failed" }, err);
      return null;
    });
    // Best-effort heartbeat for observability; stamped even on a failed drain
    // (which logs on its own path), since it only proves the lane executed.
    await recordHeartbeat("bulk-reassign").catch(() => {});
    if (summary) {
      log.info("bulk-reassign", {
        msg: "drain tick",
        processed: summary.processed,
        moved: summary.moved,
        unplaceable: summary.unplaceable,
        skipped: summary.skipped,
        failed: summary.failed,
        pending: summary.pending,
        cancelled: summary.cancelled,
        unclaimed: summary.unclaimed,
      });
    }
    return NextResponse.json(summary ?? { error: "drain-failed" });
  } finally {
    await releaseLock("cron_bulk_reassign", lock);
  }
}

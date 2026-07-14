import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { reportSweepSaturation } from "@/lib/monitor/sweep-saturation";
import { rotateSelfhealScan } from "@/lib/booking/selfheal-cursor";
import {
  processPendingEventDeletions,
  reconcileCancelledBusyBlocks,
  reconcileMissingBusyBlocks,
} from "@/lib/booking/service";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

// Own lock + own every-minute lane so the self-heal sweeps get GUARANTEED
// execution (#433). They used to run as best-effort tail calls at the end of
// the sync lane, where a busy ~200-agent tick exhausts the 25s budget and
// truncates before they run — exactly when crash/failure likelihood (and so the
// need to self-heal a stuck or missing slot) is highest. Short TTL: these are
// quick, bounded DB scans.
const SELFHEAL_LOCK_TTL_MS = 2 * 60_000;

// Bounds per tick. The deletion drain matches the old sync-tail batch (#401);
// the reconcile sweeps scan only upcoming rows so these caps are generous.
const DELETION_DRAIN_LIMIT = 20;
const RECONCILE_LIMIT = 200;

// #726 saturation streak keys (rate_limits + alert_state rows).
const RECONCILE_CANCELLED_SATURATED_KEY = "reconcile_cancelled_saturated";
const RECONCILE_MISSING_SATURATED_KEY = "reconcile_missing_saturated";

// #512 rotating-scan cursor keys (selfheal_scan_cursor rows). Distinct row sets,
// so each sweep rotates its own offset.
const RECONCILE_CANCELLED_SCAN_KEY = "reconcile_cancelled_scan";
const RECONCILE_MISSING_SCAN_KEY = "reconcile_missing_scan";

/**
 * Self-heal lane (#433): the booking-safety sweeps, on a guaranteed every-minute
 * lane of their own instead of leftover sync time.
 *   1. #401 — drain failed calendar-event-deletion retries.
 *   2. #428 — free busy_blocks stuck busy for a cancelled/missing booking.
 *   3. #431 — re-create busy_blocks missing for an active booking (the slot was
 *      showing free and could be double-booked).
 * Each is best-effort and independent: one failing must not stop the others.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const lock = await acquireLock("cron_selfheal", SELFHEAL_LOCK_TTL_MS);
  if (!lock) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    const deletions = await processPendingEventDeletions(DELETION_DRAIN_LIMIT).catch(
      (err) => {
        log.error("selfheal", { msg: "deletion drain failed" }, err);
        return null;
      },
    );
    // #512: rotate each sweep's scan window across ticks so rows past the first
    // page are eventually covered, not starved. rotateSelfhealScan feeds the
    // stored offset in and advances the cursor on a full page.
    const freed = await rotateSelfhealScan(RECONCILE_CANCELLED_SCAN_KEY, RECONCILE_LIMIT, (offset) =>
      reconcileCancelledBusyBlocks(RECONCILE_LIMIT, offset).catch((err) => {
        log.error("selfheal", { msg: "cancelled-reconcile failed" }, err);
        return null;
      }),
    );
    const recreated = await rotateSelfhealScan(RECONCILE_MISSING_SCAN_KEY, RECONCILE_LIMIT, (offset) =>
      reconcileMissingBusyBlocks(RECONCILE_LIMIT, offset).catch((err) => {
        log.error("selfheal", { msg: "missing-reconcile failed" }, err);
        return null;
      }),
    );

    // #726: a sweep that hits its cap every tick is not healthy, it is behind. Both
    // reconciles are capped, so both can hide a growing backlog; page once either
    // has been saturated for SATURATION_ALERT_AFTER_MS straight.
    await reportSweepSaturation(
      "cancelled-block reconcile",
      RECONCILE_CANCELLED_SATURATED_KEY,
      freed?.freed ?? null,
      RECONCILE_LIMIT,
    );
    await reportSweepSaturation(
      "missing-block reconcile",
      RECONCILE_MISSING_SATURATED_KEY,
      recreated?.recreated ?? null,
      RECONCILE_LIMIT,
    );

    // Dead-man's switch (#420/#685): prove this lane ran this tick. Best-effort.
    // Stamped even when a sub-sweep returned its "error" marker (those are
    // logged/alerted separately); the heartbeat only proves the lane executed.
    await recordHeartbeat("selfheal").catch(() => {});
    return NextResponse.json({
      deletionsDrained: deletions ?? "error",
      stuckFreed: freed?.freed ?? "error",
      missingRecreated: recreated?.recreated ?? "error",
      // #512: how many rows each sweep scanned this tick, so the bounded scan and
      // its rotation are observable (a persistent `scanned === cap` means a
      // backlog is being paged through, not fully drained in one tick).
      cancelledScanned: freed?.scanned ?? "error",
      missingScanned: recreated?.scanned ?? "error",
    });
  } finally {
    await releaseLock("cron_selfheal", lock);
  }
}

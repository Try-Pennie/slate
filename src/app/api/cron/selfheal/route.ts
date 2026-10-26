import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLock, releaseLock } from "@/lib/locks";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import {
  reportDeletionSaturation,
  reportSweepSaturation,
} from "@/lib/monitor/sweep-saturation";
import { rotateSelfhealScan } from "@/lib/booking/selfheal-cursor";
import {
  processPendingEventDeletions,
  checkCreationOrphans,
  reconcileCancelledBusyBlocks,
  reconcileMissingBusyBlocks,
} from "@/lib/booking/service";
import { reconcileOrphanedPoolExits } from "@/lib/google/sync";
import { sweepExpiredRerouteHoldBlocks } from "@/lib/booking/reroute-hold-store";
import { rerouteHoldStoreDeps } from "@/lib/booking/reroute-hold-store-live";
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
// #830: creation-orphan check probes Google once per orphan (events.get), so cap
// it under the Worker subrequest ceiling; the deletion drain still retries the
// removal of any not reached this tick.
const CREATION_ORPHAN_CHECK_LIMIT = 20;
// #239/#248: how many orphaned-watch agents to tear down per tick. Each teardown
// makes Google calls (one stopChannel per calendar), so cap it under the Worker
// subrequest ceiling; rotation catches any larger historical backlog next tick.
const POOL_EXIT_RECONCILE_LIMIT = 25;

// #726 saturation streak keys (rate_limits + alert_state rows).
const RECONCILE_CANCELLED_SATURATED_KEY = "reconcile_cancelled_saturated";
const RECONCILE_MISSING_SATURATED_KEY = "reconcile_missing_saturated";
// #888: same treatment for the deletion drain, the one capped sweep on this lane
// that was never wired to a saturation signal.
const DELETION_DRAIN_SATURATED_KEY = "deletion_drain_saturated";

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
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/selfheal");
  if (claimed) return claimed;

  // lock-overlap: Google event deletes treat a 404 as done and busy block recreates are
  // deduplicated by the unique index on booking_id, so overlapping runs repeat work
  // rather than corrupt it; the residual is a duplicate alert and the scan cursor
  // jumping one window.
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
    // #830: surface creation orphans (event created, booking never persisted)
    // early and distinctly, gated on the event still existing on Google.
    const creationOrphans = await checkCreationOrphans(CREATION_ORPHAN_CHECK_LIMIT).catch(
      (err) => {
        log.error("selfheal", { msg: "creation-orphan check failed" }, err);
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

    // #888: the deletion drain is capped too, so it hides a growing backlog the
    // same way. Passes the whole drain result: saturation is the size of the page
    // it loaded (deleted + failed), which the reporter owns.
    await reportDeletionSaturation(
      DELETION_DRAIN_SATURATED_KEY,
      deletions,
      DELETION_DRAIN_LIMIT,
    ).catch(() => {});

    // #239/#248: mop up agents that left the bookable pool without going through
    // the toggle (SF deactivation) or before the synchronous hook existed. Stops
    // their orphaned Google watches and prunes their cached busy_blocks.
    const poolExit = await reconcileOrphanedPoolExits(POOL_EXIT_RECONCILE_LIMIT).catch(
      (err) => {
        log.error("selfheal", { msg: "pool-exit reconcile failed" }, err);
        return null;
      },
    );

    // #3248: remove the slot cache block of every reroute hold that expired
    // unconfirmed, and refresh the buckets of the advisors it frees. The booker and
    // the database already ignore an expired hold the instant it expires; this is
    // what puts the time back on the offer. Its OWN heartbeat, stamped only when it
    // succeeded, because the lane's stamp below proves only that the lane ran.
    // Built inside the promise chain, so even a throw while wiring the deps lands in
    // this sweep's own catch rather than ending the tick (L73).
    const holdSweep = await Promise.resolve()
      .then(() => sweepExpiredRerouteHoldBlocks(rerouteHoldStoreDeps("reroute-hold-sweep", "inline")))
      .catch(
      (err) => {
        log.error("selfheal", { msg: "reroute hold sweep failed" }, err);
        return null;
      },
    );
    if (holdSweep) await recordHeartbeat("reroute-hold-sweep").catch(() => {});

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
      // #239/#248: pool-exit cleanup this tick (agents cleaned + blocks pruned).
      poolExitCleaned: poolExit?.cleaned ?? "error",
      poolExitBlocksDeleted: poolExit?.blocksDeleted ?? "error",
      // #830: creation orphans confirmed present on Google this tick.
      creationOrphans: creationOrphans ? creationOrphans.confirmed.length : "error",
      // #3248: expired reroute hold blocks removed this tick.
      rerouteHoldBlocksFreed: holdSweep?.freed ?? "error",
    });
  } finally {
    await releaseLock("cron_selfheal", lock);
  }
}

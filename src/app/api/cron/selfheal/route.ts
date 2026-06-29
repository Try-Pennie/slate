import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import {
  processPendingEventDeletions,
  reconcileCancelledBusyBlocks,
  reconcileMissingBusyBlocks,
} from "@/lib/booking/service";

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
        console.error(`selfheal: deletion drain failed: ${err}`);
        return null;
      },
    );
    const freed = await reconcileCancelledBusyBlocks(RECONCILE_LIMIT).catch((err) => {
      console.error(`selfheal: cancelled-reconcile failed: ${err}`);
      return null;
    });
    const recreated = await reconcileMissingBusyBlocks(RECONCILE_LIMIT).catch((err) => {
      console.error(`selfheal: missing-reconcile failed: ${err}`);
      return null;
    });

    return NextResponse.json({
      deletionsDrained: deletions ?? "error",
      stuckFreed: freed?.freed ?? "error",
      missingRecreated: recreated?.recreated ?? "error",
    });
  } finally {
    await releaseLock("cron_selfheal", lock);
  }
}

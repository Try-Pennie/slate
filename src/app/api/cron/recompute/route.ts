import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { withinBudget } from "@/lib/google/sync-pace";
import { acquireLock, releaseLock } from "@/lib/locks";
import { RECOMPUTE_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { recomputeBucketSlotsForToday } from "@/lib/availability/slot-cache";
import {
  listAllBucketCodes,
  listKnownBucketSlotRows,
} from "@/lib/availability/precompute";
import {
  orderBucketsForRecompute,
  staleBuckets,
} from "@/lib/availability/precompute-cron";

export const dynamic = "force-dynamic";

// Own budget for the recompute lane (#273): the whole request is recompute, so
// this is a generous ceiling — not the 10s leftover it got after sync used to
// eat the shared tick. Must stay under RECOMPUTE_LOCK_TTL_MS.
const RECOMPUTE_BUDGET_MS = 50_000;
const STALE_BUDGET_MS = 90_000;
const STALE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * RECOMPUTE lane: keeps the precomputed `bucket_slots` cache fresh, independent
 * of per-agent calendar sync. Runs every minute under its OWN lock so a busy
 * sync tick can never starve the slot refresh (the documented stale-bucket
 * root cause, #273). Rotates through every bucket least-recently-computed
 * first within its budget; the tail is picked up next tick. Touched-bucket
 * latency is owned by the real-time push/booking/OOO recomputes — this is the
 * guaranteed-freshness floor behind them.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // Overlapping invocations would recompute the same buckets for nothing; the
  // lock referees both the every-minute cadence and the duplicate cron worker.
  const lock = await acquireLock("cron_recompute", RECOMPUTE_LOCK_TTL_MS);
  if (!lock) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    const [known, allCodes] = await Promise.all([
      listKnownBucketSlotRows(),
      listAllBucketCodes(),
    ]);
    // No in-tick "touched" signal in a standalone lane: pure rotation, least-
    // recently-computed (never-computed = 0, so they sort to the front).
    const order = orderBucketsForRecompute([], known, allCodes);
    const deadlineMs = Date.now() + RECOMPUTE_BUDGET_MS;
    let recomputed = 0;
    for (const code of order) {
      if (!withinBudget(Date.now(), deadlineMs)) break;
      await recomputeBucketSlotsForToday(code, true);
      recomputed++;
    }

    const stale = staleBuckets(known, allCodes, Date.now(), STALE_BUDGET_MS);
    if (stale.length) {
      await sendThrottledAlert(
        "bucket_slots_stale",
        STALE_ALERT_COOLDOWN_MS,
        `Slate: ${stale.length} bucket_slots row(s) stale >${STALE_BUDGET_MS / 1000}s (e.g. ${stale.slice(0, 5).join(", ")}); a precompute writer may be stuck.`,
      ).catch(() => {});
    }

    return NextResponse.json({
      buckets: allCodes.length,
      recomputed,
      staleBuckets: stale.length,
    });
  } finally {
    await releaseLock("cron_recompute", lock);
  }
}

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
  bucketsDueForRecompute,
  staleBuckets,
  recomputeHeadroom,
} from "@/lib/availability/precompute-cron";

export const dynamic = "force-dynamic";

// Only re-derive buckets older than this (#294). Real-time push/booking keep
// CHANGED buckets fresh in seconds; this lane just covers the day-window slide
// and the missed-push backstop, so it doesn't need to touch every bucket every
// minute. Recomputing all 60 every minute saturated the lane at ~110 agents.
const RECOMPUTE_FRESH_MS = 4 * 60_000;
// Alarm only if a bucket is STILL stale beyond this after the run — i.e. the
// lane genuinely can't keep up (a wedged writer), not just normal aging.
const STALE_ALARM_MS = 6 * 60_000;
// Hard per-tick cap so a slow run can't overrun the lock TTL.
const RECOMPUTE_BUDGET_MS = 50_000;
const STALE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
// Early warning: flag when a run uses >= this fraction of its budget (or can't
// drain the due set) so saturation is visible BEFORE buckets actually go stale.
const HEADROOM_WARN_FRACTION = 0.7;
const HEADROOM_ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // at most every 2h

/**
 * RECOMPUTE lane: keeps the precomputed `bucket_slots` cache fresh, independent
 * of per-agent calendar sync, under its OWN lock so a busy sync tick can't
 * starve it (#273). It recomputes only buckets aging past the freshness window
 * (#294), oldest-first within its budget; the tail is picked up next tick.
 * Real-time freshness for just-changed buckets is owned by the push/booking/OOO
 * recomputes — this is the day-window + missed-push backstop floor behind them.
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
    // Only the buckets aging past the freshness window, oldest-first.
    const due = bucketsDueForRecompute(known, allCodes, Date.now(), RECOMPUTE_FRESH_MS);
    const startedMs = Date.now();
    const deadlineMs = startedMs + RECOMPUTE_BUDGET_MS;
    let recomputed = 0;
    for (const code of due) {
      if (!withinBudget(Date.now(), deadlineMs)) break;
      await recomputeBucketSlotsForToday(code, true);
      recomputed++;
    }
    const runMs = Date.now() - startedMs;

    // Early warning (no behavior change): if the run is approaching its budget
    // or couldn't drain the due set, surface it now — before buckets go stale —
    // so there's time to scale (widen the freshness window, or the DO fallback).
    const headroom = recomputeHeadroom(
      runMs,
      RECOMPUTE_BUDGET_MS,
      due.length,
      recomputed,
      HEADROOM_WARN_FRACTION,
    );
    if (headroom.warn) {
      await sendThrottledAlert(
        "recompute_headroom",
        HEADROOM_ALERT_COOLDOWN_MS,
        `Slate: bucket recompute is approaching capacity (used ${headroom.utilizationPct}% of its budget, refreshed ${recomputed}/${due.length} due buckets across ${allCodes.length} total). It's still keeping up, but consider scaling (widen the freshness window or move to the Durable-Objects design) before availability goes stale.`,
      ).catch(() => {});
    }

    // Alarm on what's STILL stale AFTER recomputing (re-read so buckets we just
    // refreshed don't count): that's a genuine fall-behind, not normal aging.
    const after = await listKnownBucketSlotRows();
    const stale = staleBuckets(after, allCodes, Date.now(), STALE_ALARM_MS);
    if (stale.length) {
      await sendThrottledAlert(
        "bucket_slots_stale",
        STALE_ALERT_COOLDOWN_MS,
        `Slate: ${stale.length} bucket_slots row(s) stale >${STALE_ALARM_MS / 60_000}m (e.g. ${stale.slice(0, 5).join(", ")}); a precompute writer may be stuck.`,
      ).catch(() => {});
    }

    return NextResponse.json({
      buckets: allCodes.length,
      due: due.length,
      recomputed,
      staleBuckets: stale.length,
      utilizationPct: headroom.utilizationPct,
      drained: headroom.drained,
    });
  } finally {
    await releaseLock("cron_recompute", lock);
  }
}

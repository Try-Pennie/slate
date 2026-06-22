import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isAuthorizedCron } from "@/lib/cron";
import { withinBudget } from "@/lib/google/sync-pace";
import { acquireLock, releaseLock } from "@/lib/locks";
import { RECOMPUTE_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { isConsecutiveFailure } from "@/lib/notify/alerts";
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
const HEADROOM_ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // at most every 2h
// "Falling behind" = a cycle couldn't drain its due set within budget. A single
// such cycle is usually transient (e.g. a post-deploy catch-up burst), so only
// alert when it persists on CONSECUTIVE cycles (#43-style streak): each behind
// cycle bumps the key inside this window, a clean (drained) cycle clears it, and
// the second consecutive bump trips the alert. Keeps the gauge quiet unless the
// lane genuinely can't keep up.
const RECOMPUTE_STREAK_KEY = "cron_recompute_behind";
const RECOMPUTE_STREAK_WINDOW_S = 600;

/**
 * Alert only when the recompute lane is PERSISTENTLY behind (couldn't drain the
 * due set on consecutive cycles). A drained cycle clears the streak and stays
 * silent regardless of how much budget it used — keeping up is not actionable.
 */
async function alertIfFallingBehind(
  headroom: { drained: boolean; utilizationPct: number },
  recomputed: number,
  due: number,
  totalBuckets: number,
): Promise<void> {
  const db = supabaseAdmin();
  if (headroom.drained) {
    await db.from("rate_limits").delete().eq("key", RECOMPUTE_STREAK_KEY);
    return;
  }
  const { data: underLimit, error } = await db.rpc("rate_limit_hit", {
    p_key: RECOMPUTE_STREAK_KEY,
    p_window_seconds: RECOMPUTE_STREAK_WINDOW_S,
    p_max: 1,
  });
  if (error) {
    console.error(`recompute behind-streak tracking failed: ${error.message}`);
    return;
  }
  if (!isConsecutiveFailure(underLimit === false ? 2 : 1)) return;
  await sendThrottledAlert(
    "recompute_headroom",
    HEADROOM_ALERT_COOLDOWN_MS,
    `Slate: bucket recompute is falling behind. Refreshed only ${recomputed} of ${due} due buckets within its time budget on consecutive cycles (${totalBuckets} buckets total, last cycle used ${headroom.utilizationPct}%). Availability may start going stale. Scale: widen the freshness window or move to the Durable-Objects design.`,
  ).catch(() => {});
}

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

    const headroom = recomputeHeadroom(runMs, RECOMPUTE_BUDGET_MS, due.length, recomputed);
    // One line per cycle so the headroom TREND is visible in Worker logs without
    // having to reconstruct it from bucket_slots timestamps after the fact.
    console.log(
      `recompute cycle: refreshed ${recomputed}/${due.length} due (${allCodes.length} total), ${headroom.utilizationPct}% of budget, drained=${headroom.drained}`,
    );
    // Alert only when PERSISTENTLY behind, not on a single busy-but-drained cycle.
    await alertIfFallingBehind(headroom, recomputed, due.length, allCodes.length);

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

import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isAuthorizedCron } from "@/lib/cron";
import { withinBudget } from "@/lib/google/sync-pace";
import { acquireLock, releaseLock } from "@/lib/locks";
import { RECOMPUTE_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { sendThrottledAlert, resolveRecovered } from "@/lib/notify/dispatch";
import { isConsecutiveFailure } from "@/lib/notify/alerts";
import { recomputeBucketSlotsForToday } from "@/lib/availability/slot-cache";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { eligibleAgentIdsCached } from "@/lib/availability/eligible-cache";
import {
  listAllBucketCodes,
  listKnownBucketSlotRows,
  readMassInvalidationMarker,
  clearMassInvalidation,
} from "@/lib/availability/precompute";
import { log } from "@/lib/log";
import {
  bucketSlotsStaleAlert,
  bucketSlotsStaleRecovery,
  bucketSlotsStaleUnreadableMarkerAlert,
  recomputeHeadroomAlert,
  recomputeHeadroomRecovery,
} from "@/lib/monitor/cron-alert-copy";
import {
  bucketsDueForRecompute,
  staleBuckets,
  staleBucketPage,
  RECOMPUTE_FRESH_MS,
  STALE_ALARM_MS,
  INVALIDATION_UNREADABLE_TOLERANCE,
  INVALIDATION_UNREADABLE_WINDOW_S,
  recomputeHeadroom,
  recomputeDueBuckets,
} from "@/lib/availability/precompute-cron";
import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";

export const dynamic = "force-dynamic";

// The freshness window and its staleness alarm are ONE PAIR, derived together in
// precompute-cron.ts (#1248), so widening the window cannot trip the alarm.
// How long a DELIBERATE mass invalidation (an admin saving a booking setting, which
// marks every bucket stale on purpose) may still be draining before its staleness
// pages anyway (#1301). Generous next to the ~1 minute a full-roster drain takes,
// because the cost of waiting is a late page while the cost of being too strict is
// the false page this whole mechanism exists to remove. Bounded on purpose: a drain
// unfinished after this IS the fall-behind the alarm is for.
const INVALIDATION_DRAIN_GRACE_MS = 15 * 60_000;

/** Streak key for consecutive unreadable-marker ticks (#1304). Its own key, so it
 *  cannot be reset by any other streak on this lane. */
const INVALIDATION_UNREADABLE_STREAK_KEY = "invalidation_marker_unreadable";
// Hard per-tick cap so a slow run can't overrun the lock TTL.
const RECOMPUTE_BUDGET_MS = 50_000;
// Recompute buckets in bounded-concurrency waves (the recompute is DB-only) so
// the lane drains its due set within budget at fleet scale (#297) — the old
// one-at-a-time loop fell ~1 bucket behind per cycle once ~110 agents were live.
// 6 matches the Cloudflare simultaneous-connection bound used elsewhere.
const RECOMPUTE_CONCURRENCY = 6;
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
    // #1151: falling behind is a CONDITION, and a cycle that drained its whole
    // due list IS the recovery. Hung off the measured healthy result rather than
    // off "we did not alert", so a cycle that could not measure clears nothing.
    return;
  }
  const { data: underLimit, error } = await db.rpc("rate_limit_hit", {
    p_key: RECOMPUTE_STREAK_KEY,
    p_window_seconds: RECOMPUTE_STREAK_WINDOW_S,
    p_max: 1,
  });
  if (error) {
    log.error("recompute", { msg: "behind-streak tracking failed" }, error);
    return;
  }
  if (!isConsecutiveFailure(underLimit === false ? 2 : 1)) return;
  await sendThrottledAlert(
    "recompute_headroom",
    HEADROOM_ALERT_COOLDOWN_MS,
    recomputeHeadroomAlert(recomputed, due, totalBuckets, headroom.utilizationPct),
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
    // #216: load the org-wide horizon once for the whole tick, not per bucket.
    const horizonDays = await loadBookingHorizonDays();
    const startedMs = Date.now();
    const deadlineMs = startedMs + RECOMPUTE_BUDGET_MS;
    // Extend the 60s shared eligible-agent cache (#421) to this lane (#508): pass
    // the cached resolver so every bucket recompute in the tick (and the monitor +
    // empty-bucket lanes sharing the same Worker invocation) reuse one eligibility
    // read per bucket instead of each re-querying the DB. The booker read + booking
    // verify keep the live resolver, so a stale cache can never mis-route a real
    // booking; the recompute row is display-only and re-verified live at book time.
    const recomputed = await recomputeDueBuckets(
      due,
      (code) => recomputeBucketSlotsForToday(code, true, (b) => eligibleAgentIdsCached(b), horizonDays),
      () => withinBudget(Date.now(), deadlineMs),
      RECOMPUTE_CONCURRENCY,
    );
    const runMs = Date.now() - startedMs;

    const headroom = recomputeHeadroom(runMs, RECOMPUTE_BUDGET_MS, due.length, recomputed);
    // One line per cycle so the headroom TREND is visible in Worker logs without
    // having to reconstruct it from bucket_slots timestamps after the fact.
    log.info("recompute", {
      msg: "cycle",
      refreshed: recomputed,
      due: due.length,
      total: allCodes.length,
      util_pct: headroom.utilizationPct,
      drained: headroom.drained,
    });
    // Alert only when PERSISTENTLY behind, not on a single busy-but-drained cycle.
    await alertIfFallingBehind(headroom, recomputed, due.length, allCodes.length);

    // Alarm on what's STILL stale AFTER recomputing (re-read so buckets we just
    // refreshed don't count): that's a genuine fall-behind, not normal aging.
    const after = await listKnownBucketSlotRows();
    const stale = staleBuckets(after, allCodes, Date.now(), STALE_ALARM_MS);
    // #1301: an admin saving a booking setting marks EVERY bucket stale on purpose,
    // and the lane cannot drain the whole roster inside the ~2 minutes between the
    // freshness window and this alarm. Staleness a recent deliberate invalidation
    // explains gets a bounded grace; the same staleness pages once that grace
    // expires, because a drain still unfinished by then IS the fall-behind this
    // alarm is for. The decision is pure and node-tested; the marker read fails
    // towards paging.
    // Read unconditionally, not only when stale: knowing whether a marker exists on
    // a HEALTHY tick is what lets the drain's end clear it, and without that a
    // genuine fall-behind minutes later would inherit a grace it never earned. One
    // indexed single-row read a minute on a lane that already does several.
    const marker = await readMassInvalidationMarker();
    // Count consecutive UNREADABLE ticks, and clear the count the moment the read
    // works again (#1304), so "three in a row" means three in a row rather than
    // three ever. The streak is only consulted for the unreadable case; an absent
    // marker still pages on the first tick.
    let unreadableToleranceReached = false;
    if (marker.state === "unreadable") {
      unreadableToleranceReached = await recordConsecutiveStreak(
        INVALIDATION_UNREADABLE_STREAK_KEY,
        INVALIDATION_UNREADABLE_WINDOW_S,
        INVALIDATION_UNREADABLE_TOLERANCE,
      );
    } else {
      // Cleared on ANY readable tick, including an absent marker, so "three in a
      // row" means three in a row rather than three ever. Without this a marker
      // that failed once a day for three days would page as though it had been
      // unreadable for three minutes.
      await clearFailureStreak(INVALIDATION_UNREADABLE_STREAK_KEY);
    }
    const verdict = staleBucketPage(
      stale.length,
      marker,
      Date.now(),
      INVALIDATION_DRAIN_GRACE_MS,
      unreadableToleranceReached,
    );
    if (stale.length) {
      log.info("recompute", { msg: "stale check", stale: stale.length, page: verdict.page, why: verdict.reason });
    }
    if (verdict.page) {
      // Two different pages on one key (#1304). A staleness we could not EXPLAIN
      // is not the same finding as one we measured, and the ordinary wording would
      // send the reader to the precompute writers when the thing to look at is the
      // marker read.
      const text =
        marker.state === "unreadable"
          ? bucketSlotsStaleUnreadableMarkerAlert(
              stale.length,
              STALE_ALARM_MS / 60_000,
              stale.slice(0, 5),
              INVALIDATION_UNREADABLE_TOLERANCE,
            )
          : bucketSlotsStaleAlert(stale.length, STALE_ALARM_MS / 60_000, stale.slice(0, 5));
      await sendThrottledAlert("bucket_slots_stale", STALE_ALERT_COOLDOWN_MS, text).catch(() => {});
    }

    // #1151: both of this lane's alerts describe CONDITIONS that end, so say when
    // they do. Only conditions MEASURED healthy this cycle go in the list: a
    // cycle that drained its due list proves the headroom condition is over, and
    // a post-recompute re-read finding nothing stale proves the other is. Batched
    // into one alert_state read because this lane runs every minute and shares a
    // subrequest budget with three others.
    const recovered: { key: string; text: string }[] = [];
    if (headroom.drained) {
      recovered.push({
        key: "recompute_headroom",
        text:
          recomputeHeadroomRecovery(),
      });
    }
    if (stale.length === 0) {
      recovered.push({
        key: "bucket_slots_stale",
        text:
          bucketSlotsStaleRecovery(),
      });
      // The drain is finished, so drop the grace marker: the NEXT staleness must
      // page at once rather than inheriting a grace it did not earn (#1301).
      //
      // Also cleared when the marker was UNREADABLE (#1304). The delete is
      // idempotent, so at worst it removes nothing, and that is the safer side:
      // leaving a marker we could not read would hand a grace to a genuine
      // fall-behind minutes later, which is the exact failure #1301 was about.
      if (marker.state !== "absent") await clearMassInvalidation();
    }
    if (recovered.length > 0) {
      // alert-key: recompute_headroom
      // alert-key: bucket_slots_stale
      const cleared = await resolveRecovered(recovered);
      if (cleared.length) log.info("recompute", { msg: "alerts cleared", keys: cleared.join(",") });
    }

    // Dead-man's switch (#420/#685): prove this lane ran this tick. Best-effort.
    await recordHeartbeat("recompute").catch(() => {});
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

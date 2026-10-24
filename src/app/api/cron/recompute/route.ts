import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { withinBudget } from "@/lib/google/sync-pace";
import { acquireLock, releaseLock } from "@/lib/locks";
import { RECOMPUTE_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { sendThrottledAlert, resolveRecovered } from "@/lib/notify/dispatch";
import { logAlertSendFailure } from "@/lib/notify/send-failure";
import { recomputePoolSlotsForToday } from "@/lib/availability/slot-cache";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { readEligibleCached } from "@/lib/availability/eligible-cache";
import {
  listPoolBuckets,
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
import { groupByPool } from "@/lib/availability/pool-key";
import { groupingEntriesOf } from "@/lib/booking/pool-grouping";
import { publishPoolGrouping } from "@/lib/booking/pool-grouping-live";
import { POOL_GROUPING_LANE } from "@/lib/monitor/health";
import { poolsDueForRecompute, type PooledBucket } from "@/lib/availability/pool-recompute";
import {
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
import {
  judgeRecomputeCycle,
  RECOMPUTE_BEHIND_CYCLES,
  RECOMPUTE_REARM_CYCLES,
} from "@/lib/availability/recompute-alert";

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
// "Falling behind" = a cycle could not drain its due set within budget. It pages
// only once that has held for longer than the freshness window, and the all-clear
// waits just as long for the lane to have KEPT UP (#2021): both thresholds and
// the streak keys live in recompute-alert.ts, pure and node-tested, and the
// streaks themselves are the shared `rate_limit_hit` counter.
const recomputeStreaks = { bump: recordConsecutiveStreak, clear: clearFailureStreak };

/**
 * Alert only when the recompute lane is PERSISTENTLY behind, and report whether
 * it has been persistently caught up, so the caller can hang the all-clear off
 * that rather than off one healthy cycle (L160). A cycle that could not track
 * its streak reports neither.
 */
async function judgeHeadroom(
  headroom: { drained: boolean; utilizationPct: number },
  recomputed: number,
  due: number,
  totalBuckets: number,
): Promise<{ recovered: boolean }> {
  const verdict = await judgeRecomputeCycle(headroom.drained, recomputeStreaks);
  if (verdict.page) {
    await sendThrottledAlert(
      "recompute_headroom",
      HEADROOM_ALERT_COOLDOWN_MS,
      recomputeHeadroomAlert(
        recomputed,
        due,
        totalBuckets,
        headroom.utilizationPct,
        RECOMPUTE_BEHIND_CYCLES,
      ),
    ).catch(logAlertSendFailure("recompute_headroom"));
  }
  return { recovered: verdict.recovered };
}

/**
 * #3460: publish the pool grouping this tick read, in its own step boundary (L73), for a
 * cold server to key its confirm line from (`pool-grouping-reader.ts`). Never throws. The
 * `pool-grouping` heartbeat is stamped only when the directory STORED this tick's
 * snapshot: one it kept a newer snapshot over says the directory is fresh, not that this
 * publisher's own read is, so stamping on it could hide a publisher whose reads had gone
 * stale. A publisher that stops is paged (`POOL_GROUPING_STALE_BOUNDS_MS`), because every
 * cold server would otherwise quietly keep its code's own line.
 */
async function publishGroupingStep(buckets: PooledBucket[], readAtMs: number): Promise<void> {
  try {
    const published = await publishPoolGrouping(groupingEntriesOf(groupByPool(buckets)), readAtMs);
    if (published.ok && published.kind === "stored") await recordHeartbeat(POOL_GROUPING_LANE).catch(() => {});
  } catch (err) {
    log.error("recompute", { msg: "pool grouping publish threw; the recompute carries on" }, err);
  }
}

/**
 * #3460: the bucket read the publish needs, in its own step boundary. Null when it
 * failed, which publishes nothing this tick and leaves the recompute to read for itself
 * exactly as it did before #3460: a transient read error must never take the lane down.
 */
async function readForPublish(): Promise<PooledBucket[] | null> {
  try {
    return await listPoolBuckets();
  } catch (err) {
    log.warn("recompute", { msg: "pool grouping read failed; nothing is published this tick and the recompute carries on" }, err);
    return null;
  }
}

/**
 * RECOMPUTE lane: keeps the precomputed `bucket_slots` cache fresh, independent
 * of per-agent calendar sync, under its OWN lock so a busy sync tick can't
 * starve it (#273). It recomputes only buckets aging past the freshness window
 * (#294), oldest-first within its budget; the tail is picked up next tick.
 * Real-time freshness for just-changed buckets is owned by the push/booking/OOO
 * recomputes; this is the day-window and missed-push backstop floor behind them.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }

  // #3460: the bucket read comes BEFORE the lock, so the grouping is published even on a
  // tick the lock skips; otherwise a skipped minute leaves the snapshot to go stale (L614).
  // A skipped tick therefore pays this one read: the tick holding the lock read its
  // buckets in another invocation, at the start of its own minute, so there is nothing
  // here to reuse, and its snapshot is the one about to go stale. On every other tick the
  // recompute reuses this read, so publishing adds none. Stamped at the read's START, so
  // a snapshot is never fresher than the read behind it.
  const readAtMs = Date.now();
  const forPublish = await readForPublish();
  const publishing = forPublish ? publishGroupingStep(forPublish, readAtMs) : Promise.resolve();
  try {
    return await recomputeLocked(forPublish);
  } finally {
    // Awaited on every exit, the skipped tick's included, so the Worker never cancels it.
    await publishing;
  }
}

/** `prefetched` is the publish's read, reused; null when it failed, so the lane reads for itself. */
async function recomputeLocked(prefetched: PooledBucket[] | null) {
  // Overlapping invocations would recompute the same buckets for nothing; the
  // lock referees both the every-minute cadence and the duplicate cron worker.
  // lock-overlap: every slot write is a compare and swap on the row's stamp, the
  // oldest state its compute used (slot-row-write.ts), so an overlapping run can
  // never put older slots over newer ones; the residual is a duplicate streak count
  // or alert.
  const lock = await acquireLock("cron_recompute", RECOMPUTE_LOCK_TTL_MS);
  if (!lock) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    const [known, poolBuckets] = await Promise.all([
      listKnownBucketSlotRows(),
      prefetched ?? listPoolBuckets(),
    ]);
    const allCodes = poolBuckets.map((b) => b.code);
    // #2245: the unit of work is a POOL, not a code. Sixty codes resolve to
    // fifteen distinct pools (the legal digit stopped routing in #2218, and
    // backend digits 0 and 1 never set a backend service), so this lane was
    // running the whole multi agent availability compute sixty times to produce
    // fifteen answers. Grouping here and dispatching whole pools is the entire
    // saving; every code still gets its own row, with its own identity.
    //
    // Freshness is asked of the pool rather than of each code, because the
    // jitter gives each code its own deadline inside the window and writing all
    // six rows at the first of them would bring the pool due again a minute
    // later (see poolsDueForRecompute).
    const duePools = poolsDueForRecompute(known, groupByPool(poolBuckets), Date.now(), RECOMPUTE_FRESH_MS);
    // Counted in BUCKETS, not pools, so the headroom numbers and the alert copy
    // keep meaning what they said before (L683). A due pool refreshes every one
    // of its codes, so its whole membership is what this cycle owes.
    const due = duePools.flatMap((pool) => pool.map((b) => b.code));
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
    // The dated reader, not the bare list (#3388): a cached list is as old as its
    // read, so the pool's rows are stamped from that read when it is earlier than
    // the compute's start, and the #1048 gate keeps a row a live path wrote since.
    // The pool REPORTS how many codes it refreshed and the drain sums it. Not
    // accumulated here: `recomputed += await ...` reads the variable before it
    // awaits, so a wave of pools running at once each add to the value they saw
    // at the start and only the last one survives. That is what shipped, and it
    // reported one pool's writes as the whole cycle.
    const recomputed = await recomputeDueBuckets(
      duePools,
      (pool) =>
        recomputePoolSlotsForToday(pool, "lane", (b) => readEligibleCached(b), horizonDays),
      () => withinBudget(Date.now(), deadlineMs),
      RECOMPUTE_CONCURRENCY,
      (pool) => pool.map((b) => b.code).join("+"),
    );
    const runMs = Date.now() - startedMs;

    const headroom = recomputeHeadroom(runMs, RECOMPUTE_BUDGET_MS, due.length, recomputed);
    // One line per cycle so the headroom TREND is visible in Worker logs without
    // having to reconstruct it from bucket_slots timestamps after the fact.
    log.info("recompute", {
      msg: "cycle",
      refreshed: recomputed,
      due: due.length,
      pools: duePools.length,
      total: allCodes.length,
      util_pct: headroom.utilizationPct,
      drained: headroom.drained,
    });
    // Alert only when PERSISTENTLY behind, not on a single busy-but-drained cycle.
    const headroomVerdict = await judgeHeadroom(headroom, recomputed, due.length, allCodes.length);

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
      await sendThrottledAlert("bucket_slots_stale", STALE_ALERT_COOLDOWN_MS, text).catch(
        logAlertSendFailure("bucket_slots_stale"),
      );
    }

    // #1151: both of this lane's alerts describe CONDITIONS that end, so say when
    // they do. Only conditions MEASURED healthy go in the list: a lane that has
    // drained its due list for the whole re-arm window proves the headroom
    // condition is over (one drained cycle is the wobble the page has to survive,
    // #2021), and a post-recompute re-read finding nothing stale proves the other
    // is. Batched into one alert_state read because this lane runs every minute
    // and shares a subrequest budget with three others.
    const recovered: { key: string; text: string }[] = [];
    if (headroomVerdict.recovered) {
      recovered.push({
        key: "recompute_headroom",
        text: recomputeHeadroomRecovery(RECOMPUTE_REARM_CYCLES),
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

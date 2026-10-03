import { getBucketSlots, type EligibleResolver } from "./service";
import { slotCacheKey } from "./cache-key";
import {
  resolveBucketSlots,
  type ReadDeps,
  type CachedBucketSlots,
  type ResolvedBucketSlots,
} from "./precompute-core";
import {
  readBucketSlotsRow,
  writeBucketSlotsRow,
  storeBucketSlotsRow,
  recomputeBucketSlots,
  computeBucketSlotsForWindow,
  bucketsForAgent,
  listPoolBuckets,
  touchedBucketCodes,
} from "./precompute";
import {
  recomputePool,
  recomputeTouchedPools,
  type TouchedPoolsOutcome,
  type PooledBucket,
} from "./pool-recompute";
import { appUrl } from "@/lib/env";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadBusinessHoursCached } from "@/lib/booking/business-hours-load";
import { selectWithTierFallback } from "@/lib/routing/tier-fallback";
import { tierKeyOf } from "@/lib/routing/tiers";
import { log } from "@/lib/log";
import { parseStampMs } from "@/lib/date/stamp";
// The window and the served slot rule are shared with the bucket availability
// page, which has to say what this function produces (2026-10-02).
import { offeredWindowEndFor, servedSlotsForRung } from "./offered-window";

// Short L1 TTL: the precompute row is the source of truth, so the Cache API is
// just a per-colo accelerator. 5s keeps a far-colo read self-healing well inside
// the <5s display-freshness target.
export const SLOT_TTL_SECONDS = 5;
// Real booking window is 0-3 days, so a 4-day horizon covers it with margin.
export const HORIZON_DAYS = 4;

// `caches.default` is a Cloudflare runtime extension not in the standard lib types.
type CfCache = {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
  delete(req: Request): Promise<boolean>;
};
function slotCache(): CfCache | null {
  return (globalThis as unknown as { caches?: { default?: CfCache } }).caches?.default ?? null;
}

// Lookup-only key Request on the app's own zone (not a real route).
function keyRequest(key: string): Request {
  return new Request(`${appUrl()}/__slot-cache/${encodeURIComponent(key)}`);
}

/**
 * Read path for the embed: Cache API -> precomputed `bucket_slots` row -> bounded
 * fail-open compute. The multi-agent compute runs ONLY when no good row exists
 * (new/never-computed bucket); the steady state is a warm cache hit or one
 * indexed PK read. Orchestration + the "never compute when a good row exists"
 * invariant are unit-tested in precompute-core.ts; here we only bind real IO.
 */
export async function getCachedBucketSlots(
  code: string,
  fromIso: string,
  horizonDays = HORIZON_DAYS,
): Promise<ResolvedBucketSlots | null> {
  const cache = slotCache();
  const deps: ReadDeps = {
    cacheGet: async (key) => {
      if (!cache) return null;
      try {
        const hit = await cache.match(keyRequest(key));
        if (hit) return JSON.parse(await hit.text()) as CachedBucketSlots;
      } catch { /* fall through */ }
      return null;
    },
    cachePut: async (key, val) => {
      if (!cache) return;
      try {
        await cache.put(
          keyRequest(key),
          new Response(JSON.stringify(val), {
            headers: {
              "content-type": "application/json",
              "cache-control": `public, max-age=${SLOT_TTL_SECONDS}`,
            },
          }),
        );
      } catch { /* ignore */ }
    },
    readRow: (c) => readBucketSlotsRow(c),
    compute: (c, from, to) => getBucketSlots(c, from, to),
    writeRow: (c, val, computedAtMs) => writeBucketSlotsRow(c, val, computedAtMs),
    // #3119: the lead is still served what was computed; the row it could not store
    // is said here, and the next request or the cron backstop computes it again.
    writeFailed: (c, err) =>
      log.warn("slot-cache", { msg: "self-heal slot row not stored", bucket: c }, err),
    // #1296: the CURRENT org hours, so a narrowing filters the cached slots on the
    // very next request rather than waiting for a recompute. One read per isolate
    // per SLOT_TTL_SECONDS; a failed refresh serves the last known week.
    businessHours: loadBusinessHoursCached,
  };
  return resolveBucketSlots(code, fromIso, horizonDays, deps);
}

// Best-effort per-isolate dedupe: collapse a burst of recompute requests for the
// same bucket (e.g. a flurry of Google pushes) into at most one every 2s. The
// cron backstop guarantees freshness regardless, so a skipped recompute is safe.
const RECOMPUTE_SKIP_MS = 2000;
const lastRecomputeAt = new Map<string, number>();

/**
 * Refresh a bucket's precomputed row over the org-wide horizon, then clear its L1
 * cache key so the next read serves the fresh row. Called by the refresh-on-change
 * writers (booking / Google sync / OOO), the cron backstop, and the admin
 * horizon-save (#216). Debounced per bucket; pass force=true (the cron) to bypass.
 *
 * The COMPUTE WINDOW tracks the runtime horizon (#216) so raising the horizon makes
 * rows actually span more days and lowering it bounds them. The L1 cache KEY stays
 * on the fixed `HORIZON_DAYS` namespace so it always matches what the read path
 * (which never reads the setting, keeping the hot path DB-free) looks up and
 * invalidates. Pass `horizonDays` to avoid a per-call settings read when a caller
 * loops over many buckets and has already loaded it once; omitted, it self-loads
 * (a missed thread is a harmless extra read, never a wrong window).
 */
export async function recomputeBucketSlotsForToday(
  code: string,
  force = false,
  resolveEligible?: EligibleResolver,
  horizonDays?: number,
): Promise<void> {
  const now = Date.now();
  if (!force && now - (lastRecomputeAt.get(code) ?? 0) < RECOMPUTE_SKIP_MS) return;
  lastRecomputeAt.set(code, now);

  const nowIso = new Date().toISOString();
  const horizon = horizonDays ?? (await loadBookingHorizonDays());
  const { fromIso, toIso } = slotCacheKey(code, nowIso, horizon);
  // L1 key on the fixed namespace so read/invalidate always agree.
  const { key } = slotCacheKey(code, nowIso, HORIZON_DAYS);
  // The horizon is a count of BOOKABLE days (#1326), so it is passed through as the
  // trim target rather than being implied by the window, which is deliberately wider.
  // A refused row now THROWS (#3119) and reaches the caller's failure path. The L1
  // entry is still dropped first, as the pooled path does: a stale entry must never
  // outlive the attempt, and the read behind it falls through to the stored row.
  try {
    await recomputeBucketSlots(code, fromIso, toIso, resolveEligible, horizon);
  } finally {
    const cache = slotCache();
    if (cache) {
      try { await cache.delete(keyRequest(key)); } catch { /* ignore */ }
    }
  }
}

/**
 * Refresh a whole POOL over the org-wide horizon: one availability compute,
 * written to every bucket code in the pool, each with its own identity (#2245).
 * Returns how many codes were actually stored.
 *
 * This is what the every minute lane dispatches. Sixty codes resolve to fifteen
 * pools, so the lane was running the compute sixty times for fifteen answers, on
 * the lane whose headroom already pages (#2021).
 *
 * Deliberately NOT debounced. The per code entry point above collapses a burst of
 * pushes for one bucket; this one is only ever called by the cron with force, and
 * a second debounce keyed on the pool would silently skip a due pool.
 *
 * The window does not depend on which code computes it: `slotCacheKey` anchors
 * `from` to the start of the UTC day and derives `to` from the horizon alone, so
 * the representative's code decides nothing about the answer.
 */
export async function recomputePoolSlotsForToday(
  pool: PooledBucket[],
  resolveEligible?: EligibleResolver,
  horizonDays?: number,
): Promise<number> {
  const representative = pool[0];
  if (!representative) return 0;
  const nowIso = new Date().toISOString();
  const horizon = horizonDays ?? (await loadBookingHorizonDays());
  const { fromIso, toIso } = slotCacheKey(representative.code, nowIso, horizon);

  const outcome = await recomputePool(pool, {
    nowMs: Date.now,
    compute: (code) =>
      computeBucketSlotsForWindow(code, fromIso, toIso, resolveEligible, horizon),
    writeRow: (code, val, computedAtMs) => storeBucketSlotsRow(code, val, computedAtMs),
    // The L1 key is on the fixed HORIZON_DAYS namespace, the same one the read
    // path looks up, so read and invalidate always agree.
    invalidate: (code) => invalidateBucketSlots(code),
  });

  if (outcome.failed.length > 0) {
    // Counted out loud rather than swallowed: these codes keep serving their
    // previous row, so the only other trace would be the stale alarm minutes later.
    log.warn("slot-cache", {
      msg: "pooled slot write failed for some codes",
      pool: representative.code,
      codes: outcome.failed.join(","),
    });
  }
  return outcome.written.length;
}

/**
 * How long an agent's pool refresh may keep STARTING pools (#2922). It runs after
 * the response, where Cloudflare cancels whatever is still going 30 seconds after
 * the response ends, and on the push path the calendar sync spends a few of those
 * seconds first. A pool takes about four seconds, so twenty leaves room for the
 * last one started to finish; anything not started is left to the every minute
 * lane rather than being cut off mid write.
 */
export const AGENT_RECOMPUTE_BUDGET_MS = 20_000;

/** When each pool was last started in this isolate, for the burst debounce. */
const lastPoolRecomputeAt = new Map<string, number>();

/**
 * Recompute every bucket an agent affects (their calendar/OOO just changed), one
 * compute per POOL rather than per code (#2922), inside a budget. Resolves to what
 * it did, or null when it could not even work out the agent's buckets. Never
 * throws into a push/cron path: the recompute lane's freshness sweep backstops.
 */
export async function recomputeBucketsForAgent(
  userId: string,
): Promise<TouchedPoolsOutcome | null> {
  try {
    const deadlineMs = Date.now() + AGENT_RECOMPUTE_BUDGET_MS;
    const [codes, buckets, horizon] = await Promise.all([
      bucketsForAgent(userId),
      listPoolBuckets(),
      // Loaded once for the whole fan-out, not once per pool.
      loadBookingHorizonDays(),
    ]);
    const outcome = await recomputeTouchedPools(codes, buckets, {
      nowMs: Date.now,
      deadlineMs,
      recomputePool: (pool) => recomputePoolSlotsForToday(pool, undefined, horizon),
      lastRunAt: lastPoolRecomputeAt,
      skipMs: RECOMPUTE_SKIP_MS,
      // The push path is bounded by its budget alone, as it was in #2922: it runs
      // after the response and its deadline is the platform's 30 second cut, which
      // the I/O in every pool compute keeps the clock advancing towards. One agent
      // is in at most a handful of pools, so there is no count to hold it to.
      maxPools: Number.POSITIVE_INFINITY,
    });
    // One line per refresh, so the push path's completed refreshes can be counted
    // against Cloudflare's cancellation warnings (#2922). A cancelled refresh
    // writes nothing, which is why the count lives on the side that finished.
    log.info("slot-cache", { msg: "agent pools recomputed", user_id: userId, codes: codes.length, ...outcome });
    return outcome;
  } catch (err) {
    // Best-effort: the recompute lane's freshness sweep still backstops. Log the
    // cause (#313) so a failed fan-out isn't wholly silent.
    log.error("slot-cache", { msg: "recomputeBucketsForAgent failed", user_id: userId }, err);
    return null;
  }
}

/**
 * The most pools one every minute sweep may refresh inline (#2357): the sync
 * lane's post sync refresh, and each self heal reconcile sweep.
 *
 * Those three used to recompute up to 20 (sync) and 25 (each reconcile) bucket
 * CODES one after another, each a whole pool compute, with no time bound at all.
 * Sixty codes resolve to fifteen pools (#2245), about four codes a pool, so five
 * pools cover roughly the twenty codes the old cap allowed, for a quarter of the
 * computes. On the load test Worker, whose stubbed Google answers instantly and so
 * turns every second of this into CPU, that tail is what took a minute tick to
 * 119,137 ms of CPU against the 120,000 ms kill (run 34991614423).
 *
 * A COUNT rather than only a deadline, because a Worker's clock does not advance
 * during execution: CPU spent computing reads as no time at all, so a deadline
 * alone cannot cap a fan-out whose cost is compute. Pools past it are not lost.
 * The recompute lane refreshes every pool inside its freshness window, which is
 * what has always caught the overflow past the old code cap.
 */
export const MAX_TOUCHED_POOLS_PER_SWEEP = 5;

/**
 * The wall budget beside that count: no pool is STARTED after it. A pool takes
 * about four seconds, so five fit, and this catches the tick where they are slower
 * than that (a database under load) without the count having to be the only bound.
 */
export const TOUCHED_POOLS_BUDGET_MS = 20_000;

/**
 * Refresh the pools a set of bucket codes falls in, for a cron sweep (#2357): one
 * compute per POOL, at most `maxPools` started, none started past the budget.
 *
 * Resolves to what it did, or null when the pool list or the horizon could not be
 * read, which is "could not tell" and never "nothing to do" (#1134). Never throws:
 * every caller is a best effort refresh that the recompute lane backstops. Nothing
 * touched is the ordinary tick and costs no read.
 */
export async function recomputePoolsForCodes(
  codes: string[],
  opts: { label: string; maxPools: number },
): Promise<TouchedPoolsOutcome | null> {
  if (codes.length === 0) return { refreshed: 0, deferred: 0, failed: 0, debounced: 0 };
  try {
    const deadlineMs = Date.now() + TOUCHED_POOLS_BUDGET_MS;
    const [buckets, horizon] = await Promise.all([listPoolBuckets(), loadBookingHorizonDays()]);
    const outcome = await recomputeTouchedPools(codes, buckets, {
      nowMs: Date.now,
      deadlineMs,
      recomputePool: (pool) => recomputePoolSlotsForToday(pool, undefined, horizon),
      lastRunAt: lastPoolRecomputeAt,
      skipMs: RECOMPUTE_SKIP_MS,
      maxPools: opts.maxPools,
    });
    // One line per sweep refresh, so the next load run can say how many pools each
    // tick computed and how many it left to the lane, rather than inferring it.
    log.info("slot-cache", {
      msg: "touched pools recomputed",
      label: opts.label,
      codes: codes.length,
      ...outcome,
    });
    return outcome;
  } catch (err) {
    log.error("slot-cache", { msg: "touched pools recompute failed", label: opts.label }, err);
    return null;
  }
}

/**
 * The whole refresh an every minute sweep makes for the agents it changed (#2357):
 * their bucket codes in one batched read (#762), then one bounded, pooled refresh.
 * The sync lane and both self heal reconcile sweeps call this and nothing else, so
 * the shape that let each of them loop a whole pool compute per code cannot come
 * back at one of the three while the other two stay fixed (L613).
 *
 * Every code is passed through, never a code cap applied BEFORE pooling: capping
 * codes first would leave which pools get refreshed to the order of a set. Never
 * throws; a bucket lookup that fails logs and refreshes nothing, and the recompute
 * lane is the backstop for all of it.
 */
export async function refreshPoolsForAgents(
  userIds: string[],
  label: string,
): Promise<TouchedPoolsOutcome | null> {
  if (userIds.length === 0) return { refreshed: 0, deferred: 0, failed: 0, debounced: 0 };
  const codes = await touchedBucketCodes(userIds, Number.POSITIVE_INFINITY, label);
  return recomputePoolsForCodes(codes, { label, maxPools: MAX_TOUCHED_POOLS_PER_SWEEP });
}

export interface AvailabilityRoutingMeta {
  requested_code: string;
  effective_code: string;
  tier_fallback: boolean;
  rungs_dropped: number;
  requested_tier: string | null;
  booked_tier: string | null;
  /**
   * #2841: every tier the lead's cascade may use was full for the whole offered
   * window, so times past it were served as the last resort. Somebody should look
   * whenever this is true; the availability route alerts on it.
   */
  window_extended: boolean;
}

/**
 * Cached slots for `code`; if the whole horizon window is empty, cascade down
 * the tier ladder (lower debt-tier, same backend+legal digits) and return the
 * first tier that has slots, with a routing descriptor.
 *
 * Returns null only when the requested bucket itself does not exist (→ 404),
 * or when it is a hidden test bucket and the caller isn't authorized for it.
 * When no tier has slots, returns the requested bucket with empty slots and
 * tier_fallback=false so the booker can show the "no availability" state.
 *
 * `authorizedForTest` gates synthetic test buckets (#396): an unauthorized
 * caller gets null here, BEFORE the tier cascade runs, so a hidden test bucket
 * does the same single resolve an unknown code does and its 404 timing doesn't
 * reveal that it exists (#601).
 */
export async function getBucketSlotsWithFallback(
  code: string,
  from: string,
  authorizedForTest = false,
  // Injected so the window can be driven at a fixed instant; the route passes none.
  nowMs = Date.now(),
): Promise<(ResolvedBucketSlots & { routing: AvailabilityRoutingMeta }) | null> {
  const requested = await getCachedBucketSlots(code, from);
  if (!requested) return null;
  if (requested.bucket.is_test && !authorizedForTest) return null;

  const withRouting = (
    resolved: ResolvedBucketSlots,
    rungs: number,
    windowExtended = false,
  ): ResolvedBucketSlots & { routing: AvailabilityRoutingMeta } => {
    // #2842: the second list is routing input, never output. The served list was
    // already chosen from it below, so it goes no further than this function.
    const { slotsWithoutLow: _routingOnly, ...slotsFor } = resolved;
    return {
      ...slotsFor,
      routing: {
        requested_code: code,
        effective_code: slotsFor.bucket.code,
        tier_fallback: rungs > 0,
        rungs_dropped: rungs,
        requested_tier: tierKeyOf(code),
        booked_tier: tierKeyOf(slotsFor.bucket.code),
        window_extended: windowExtended,
      },
    };
  };

  // #2840: the lead is offered the next OFFERED_OPEN_DAYS days the business is
  // open. Null when that cannot be measured, and then no window is imposed: the
  // stored rows already hold the horizon the settings ask for, which is exactly
  // what was served before this existed, so an unreadable week degrades to the
  // old behaviour rather than to no times at all.
  const windowEndMs = await offeredWindowEndMs(nowMs, requested.eventType.min_notice_min);
  const inWindow = (slots: string[]) =>
    windowEndMs === null ? slots : slots.filter((s) => (parseStampMs(s) ?? Infinity) < windowEndMs);

  // Pre-seed the seen map with the already-fetched requested bucket so neither
  // pass ever fetches it again, and the second pass reads no bucket twice.
  const seen = new Map<string, ResolvedBucketSlots | null>([[code, requested]]);
  const walk = (narrow: (slots: string[]) => string[]) =>
    selectWithTierFallback(code, async (c) => {
      if (!seen.has(c)) seen.set(c, await getCachedBucketSlots(c, from));
      const row = seen.get(c);
      // Skip synthetic test buckets on the LOWER rungs (the booking cascade skips
      // them too), so a real lower tier wins. The requested bucket is never
      // skipped: a test bucket reaching here was authorised above.
      if (c !== code && row?.bucket.is_test) return null;
      if (!row) return null;
      return narrow(servedSlotsForRung(code, c, row));
    });
  // Serve exactly the list the rung was judged on, so a rung that excludes Low
  // never shows the lead a time only a Low carrier is free for, and a rung found
  // inside the window never shows a time past it.
  const served = (
    winner: { effectiveCode: string; slots: string[]; rungsDropped: number },
    windowExtended: boolean,
  ) => {
    const bucket = seen.get(winner.effectiveCode);
    return bucket ? withRouting({ ...bucket, slots: winner.slots }, winner.rungsDropped, windowExtended) : null;
  };

  // Pass one: the allowed ladder, inside the window. The requested tier is its
  // first rung, so a lead whose own tier has a time inside the window is served it.
  const inside = await walk(inWindow);
  if (inside) return served(inside, false) ?? withRouting({ ...requested, slots: [] }, 0);
  if (windowEndMs === null) return withRouting({ ...requested, slots: [] }, 0);

  // Pass two, the last resort (#2841): every allowed tier is full for the whole
  // window, so the stored times past it are offered, the lead's own tier first.
  // Sam: "All else fails, day 4 which is 100% open." The rows reach the horizon's
  // number of days WITH times, so this is day four in the ordinary case and the
  // next day anybody allowed has free when day four is full too, rather than no
  // times at all. `window_extended` is what the route alerts on: somebody should
  // look whenever this happens.
  const beyond = await walk((slots) => slots);
  if (beyond) return served(beyond, true) ?? withRouting({ ...requested, slots: [] }, 0);
  return withRouting({ ...requested, slots: [] }, 0);
}

/**
 * When the offered window closes (#2840): the end of the `OFFERED_OPEN_DAYS`th
 * open day, counting today only while a booking can still start before it
 * closes. Null when the org's week cannot be read or holds no such day.
 */
async function offeredWindowEndMs(nowMs: number, minNoticeMin: number): Promise<number | null> {
  try {
    const hours = await loadBusinessHoursCached();
    return offeredWindowEndFor(hours, nowMs, minNoticeMin);
  } catch (err) {
    log.warn("availability", { msg: "offered window unmeasured, serving the stored horizon" }, err);
    return null;
  }
}

/**
 * Best-effort clear of a bucket's L1 cache key (per-datacenter, no prefix-list).
 * Retained for callers that only need to drop the cache; prefer
 * recomputeBucketSlotsForToday when the underlying availability changed.
 */
export async function invalidateBucketSlots(code: string): Promise<void> {
  const cache = slotCache();
  if (!cache) return;
  try {
    const { key } = slotCacheKey(code, new Date().toISOString(), HORIZON_DAYS);
    await cache.delete(keyRequest(key));
  } catch { /* ignore */ }
}

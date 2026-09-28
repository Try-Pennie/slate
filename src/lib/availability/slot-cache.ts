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
  recomputeBucketSlots,
  computeBucketSlotsForWindow,
  bucketsForAgent,
} from "./precompute";
import { recomputePool, type PooledBucket } from "./pool-recompute";
import { appUrl } from "@/lib/env";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadBusinessHoursCached } from "@/lib/booking/business-hours-load";
import { selectWithTierFallback } from "@/lib/routing/tier-fallback";
import { rungExcludesLow, tierKeyOf } from "@/lib/routing/tiers";
import { log } from "@/lib/log";

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
  await recomputeBucketSlots(code, fromIso, toIso, resolveEligible, horizon);
  const cache = slotCache();
  if (cache) {
    try { await cache.delete(keyRequest(key)); } catch { /* ignore */ }
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
    writeRow: async (code, val, computedAtMs) => {
      await writeBucketSlotsRow(code, val, computedAtMs);
    },
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
 * Recompute every bucket an agent affects (their calendar/OOO just changed).
 * Best-effort and non-blocking for the caller; never throws into a push/cron path.
 */
export async function recomputeBucketsForAgent(userId: string): Promise<void> {
  try {
    const codes = await bucketsForAgent(userId);
    // Load the horizon once for the whole fan-out, not once per bucket.
    const horizon = await loadBookingHorizonDays();
    for (const code of codes) await recomputeBucketSlotsForToday(code, false, undefined, horizon);
  } catch (err) {
    // Best-effort: the recompute lane's freshness sweep still backstops. Log the
    // cause (#313) so a failed fan-out isn't wholly silent.
    log.error("slot-cache", { msg: "recomputeBucketsForAgent failed", user_id: userId }, err);
  }
}

export interface AvailabilityRoutingMeta {
  requested_code: string;
  effective_code: string;
  tier_fallback: boolean;
  rungs_dropped: number;
  requested_tier: string | null;
  booked_tier: string | null;
}

/**
 * The times rung `rungCode` may offer a lead who asked for `requestedCode`
 * (#2842): its whole list, or, on a rung below a top tier lead's own tier, only
 * the times an advisor without Low is free. An unknown second list offers nothing
 * (`BucketSlots.slotsWithoutLow`), so the rung is skipped rather than showing the
 * lead advisors the rule keeps away.
 */
function servedSlotsForRung(
  requestedCode: string,
  rungCode: string,
  row: ResolvedBucketSlots,
): string[] {
  if (!rungExcludesLow(requestedCode, rungCode)) return row.slots;
  return row.slotsWithoutLow ?? [];
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
): Promise<(ResolvedBucketSlots & { routing: AvailabilityRoutingMeta }) | null> {
  const requested = await getCachedBucketSlots(code, from);
  if (!requested) return null;
  if (requested.bucket.is_test && !authorizedForTest) return null;

  const withRouting = (
    resolved: ResolvedBucketSlots,
    rungs: number,
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
      },
    };
  };

  if (requested.slots.length > 0) return withRouting(requested, 0);

  // Horizon window is empty: cascade down the tier ladder.
  // Pre-seed the seen map with the already-fetched requested bucket so the
  // callback never fetches it again.
  const seen = new Map<string, ResolvedBucketSlots | null>([[code, requested]]);
  const winner = await selectWithTierFallback(code, async (c) => {
    if (!seen.has(c)) seen.set(c, await getCachedBucketSlots(c, from));
    const row = seen.get(c);
    // Skip synthetic test buckets in the display cascade (the booking cascade
    // skips them too); treat like a non-existent bucket so a real lower tier wins.
    if (row?.bucket.is_test) return null;
    if (!row) return null;
    return servedSlotsForRung(code, c, row);
  });

  if (!winner || winner.rungsDropped === 0) return withRouting(requested, 0);
  const winningBucket = seen.get(winner.effectiveCode);
  if (!winningBucket) return withRouting(requested, 0);
  // Serve exactly the list the rung was judged on, so a rung that excludes Low
  // never shows the lead a time only a Low carrier is free for.
  return withRouting({ ...winningBucket, slots: winner.slots }, winner.rungsDropped);
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

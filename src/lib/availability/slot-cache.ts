import { getBucketSlots } from "./service";
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
  bucketsForAgent,
} from "./precompute";
import { appUrl } from "@/lib/env";
import { selectWithTierFallback } from "@/lib/routing/tier-fallback";
import { tierKeyOf } from "@/lib/routing/tiers";
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
    writeRow: (c, val) => writeBucketSlotsRow(c, val),
  };
  return resolveBucketSlots(code, fromIso, horizonDays, deps);
}

// Best-effort per-isolate dedupe: collapse a burst of recompute requests for the
// same bucket (e.g. a flurry of Google pushes) into at most one every 2s. The
// cron backstop guarantees freshness regardless, so a skipped recompute is safe.
const RECOMPUTE_SKIP_MS = 2000;
const lastRecomputeAt = new Map<string, number>();

/**
 * Refresh a bucket's precomputed row over the current horizon, then clear its L1
 * cache key so the next read serves the fresh row. Called by the refresh-on-change
 * writers (booking / Google sync / OOO) and the cron backstop. Debounced per
 * bucket; pass force=true (the cron) to bypass the skip.
 */
export async function recomputeBucketSlotsForToday(
  code: string,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!force && now - (lastRecomputeAt.get(code) ?? 0) < RECOMPUTE_SKIP_MS) return;
  lastRecomputeAt.set(code, now);

  const { fromIso, toIso, key } = slotCacheKey(code, new Date().toISOString(), HORIZON_DAYS);
  await recomputeBucketSlots(code, fromIso, toIso);
  const cache = slotCache();
  if (cache) {
    try { await cache.delete(keyRequest(key)); } catch { /* ignore */ }
  }
}

/**
 * Recompute every bucket an agent affects (their calendar/OOO just changed).
 * Best-effort and non-blocking for the caller; never throws into a push/cron path.
 */
export async function recomputeBucketsForAgent(userId: string): Promise<void> {
  try {
    const codes = await bucketsForAgent(userId);
    for (const code of codes) await recomputeBucketSlotsForToday(code);
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
    slotsFor: ResolvedBucketSlots,
    rungs: number,
  ): ResolvedBucketSlots & { routing: AvailabilityRoutingMeta } => ({
    ...slotsFor,
    routing: {
      requested_code: code,
      effective_code: slotsFor.bucket.code,
      tier_fallback: rungs > 0,
      rungs_dropped: rungs,
      requested_tier: tierKeyOf(code),
      booked_tier: tierKeyOf(slotsFor.bucket.code),
    },
  });

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
    return row?.slots ?? null;
  });

  if (!winner || winner.rungsDropped === 0) return withRouting(requested, 0);
  const winningBucket = seen.get(winner.effectiveCode);
  if (!winningBucket) return withRouting(requested, 0);
  return withRouting(winningBucket, winner.rungsDropped);
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

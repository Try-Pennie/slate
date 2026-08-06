import { slotCacheKey } from "./cache-key.ts";
import { shapePrecomputedRow } from "./precompute-shape.ts";
import { slotsWithinBusinessHours, type BusinessHoursRules } from "./compute.ts";
import type { BucketSlots } from "./service";

/**
 * Dependency-injected read orchestration for the precompute path, so the core
 * invariant — NEVER run the multi-agent compute when a good answer already
 * exists — is unit-testable without Cloudflare/Supabase. The real IO deps are
 * bound in slot-cache.ts; this module imports only pure helpers + a type.
 */
/** Where the served slots came from: L1 Cache API, L2 precomputed row, or a
 *  cold live compute. Surfaced as the `x-slot-cache` header (#234). */
export type SlotSource = "hit" | "row" | "compute";

/** The cached blob: the slots payload plus the freshness stamp (#257), so an L1
 *  hit can still report when the underlying row was computed. */
export type CachedBucketSlots = BucketSlots & { computedAt: string | null };

/** Resolved slots plus read metadata for the observability headers. */
export type ResolvedBucketSlots = BucketSlots & {
  source: SlotSource;
  computedAt: string | null;
};

export interface ReadDeps {
  /** L1: per-colo Cache API lookup by key. */
  cacheGet(key: string): Promise<CachedBucketSlots | null>;
  /** L1 write-through (best-effort). */
  cachePut(key: string, val: CachedBucketSlots): Promise<void>;
  /** L2: the precomputed bucket_slots row (payload + when it was computed). */
  readRow(code: string): Promise<{ payload: unknown; computed_at: string } | null>;
  /** Bounded fail-open: the live multi-agent compute (rare). */
  compute(code: string, fromIso: string, toIso: string): Promise<BucketSlots | null>;
  /** Self-heal: persist a freshly computed blob; returns its computed_at stamp. */
  writeRow(code: string, val: BucketSlots): Promise<string>;
  /**
   * The org's CURRENT opening hours (#1296), read through a short per-isolate
   * cache. Gate 1 runs at compute time, which leaves one hole: a slot computed
   * under a wider window and still sitting in the cache after a narrowing. Every
   * tier below filters against this on the way out, so a narrowing takes effect on
   * the next request instead of the next recompute.
   */
  businessHours(): Promise<BusinessHoursRules>;
}

/**
 * Cache API -> precomputed row -> bounded fail-open compute. Returns the slots
 * (same shape as before, plus `source` and `computedAt` for the observability
 * headers), or null for an unknown bucket. The compute path runs ONLY when no
 * good row exists.
 */
export async function resolveBucketSlots(
  code: string,
  fromIso: string,
  horizonDays: number,
  deps: ReadDeps,
): Promise<ResolvedBucketSlots | null> {
  const { key, fromIso: nf, toIso: nt } = slotCacheKey(code, fromIso, horizonDays);

  /**
   * The single exit (#1296). Every tier leaves through here, so no tier can return
   * a list the org's CURRENT hours would not allow.
   *
   * Note what is NOT filtered: whatever goes into `cachePut` and `writeRow` stays
   * the full computed payload. Caching the filtered list would bake one moment's
   * hours into the cache, and re-opening a day would then take a whole recompute
   * cycle to show up while closing one took effect at once. Filtering per read
   * makes both directions equally immediate.
   *
   * The cost of the extra hours read is one PostgREST round trip per isolate per
   * `SLOT_TTL_SECONDS`, not one per request; see `business-hours-cache.ts`.
   */
  const served = async (
    val: CachedBucketSlots,
    source: SlotSource,
  ): Promise<ResolvedBucketSlots> => {
    const hours = await deps.businessHours();
    return {
      ...val,
      slots: slotsWithinBusinessHours(val.slots, val.eventType.duration_min, hours),
      source,
    };
  };

  const hit = await deps.cacheGet(key);
  if (hit) return served(hit, "hit");

  const raw = await deps.readRow(code);
  const row = shapePrecomputedRow(raw);
  if (row) {
    const cached: CachedBucketSlots = { ...row, computedAt: raw!.computed_at };
    await deps.cachePut(key, cached);
    return served(cached, "row");
  }

  // Never-computed / malformed row: compute live once and self-heal.
  const fresh = await deps.compute(code, nf, nt);
  if (!fresh) return null;
  const computedAt = await deps.writeRow(code, fresh);
  const cached: CachedBucketSlots = { ...fresh, computedAt };
  await deps.cachePut(key, cached);
  return served(cached, "compute");
}

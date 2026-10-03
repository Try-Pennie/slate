import { slotCacheKey } from "./cache-key.ts";
import { mapSlotLists, shapePrecomputedRow } from "./precompute-shape.ts";
import { slotsWithinBusinessHours, type BusinessHoursRules } from "./compute.ts";
import { trimToBookableDays } from "./bookable-days.ts";
import type { BucketSlots } from "./service";

/**
 * Dependency-injected read orchestration for the precompute path, so the core
 * invariant — NEVER run the multi-agent compute when a good answer already
 * exists — is unit-testable without Cloudflare/Supabase. The real IO deps are
 * bound in slot-cache.ts; this module imports only pure helpers + a type.
 */

/**
 * What `writeRow` answers when a settings save marked the row stale after the
 * compute began (#3118): nothing was stored, and the payload describes the OLD
 * settings, so it must be neither cached nor served as if it were current.
 */
export const SUPERSEDED_BY_SAVE = "superseded-by-save" as const;
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
  /** Store the row and return the stamp to label the L1 entry with. `computedAtMs` is
   *  when the COMPUTE began, not when the write happens (#1048): the row's computed_at
   *  has to describe the data, or a slow compute landing last reports a fresh stamp
   *  over stale slots and the overwrite is invisible on the header that exists to
   *  show it. Required rather than defaulted, so every call site has to say. */
  writeRow(code: string, val: BucketSlots, computedAtMs: number): Promise<string | typeof SUPERSEDED_BY_SAVE>;
  /** The self-heal write threw (a refused row is `SlotRowRefused`, #3119). The read
   *  still serves what it computed, so this is where the refusal is recorded.
   *  Required, so every construction site has to say what it does with one. */
  writeFailed(code: string, err: unknown): void;
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
      ...mapSlotLists(val, (list) =>
        slotsWithinBusinessHours(list, val.eventType.duration_min, hours),
      ),
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

  // Never-computed / malformed row: compute live once and self-heal. The window is
  // the SEARCH range (#1326), so trim to the bookable-day count before it is written
  // or served, exactly as the recompute path does. Without this the fail-open path
  // would store more days than the setting asks for, and the one bucket that took
  // this branch would quietly offer a longer strip than every other.
  //
  // #3118: a settings save can land while this compute runs, and the write then
  // refuses it as superseded: those slots describe the OLD settings. They are neither
  // cached nor served; the compute is redone once, and the redo began after that save.
  // A second save during the redo is served to this one request without caching (the
  // fail-open path must not empty the booker) and stops there rather than looping.
  for (let attempt = 0; ; attempt++) {
    // #1048: taken before the compute reads anything, so the stored stamp describes
    // the state these slots were computed from.
    const computeStartedMs = Date.now();
    const computed = await deps.compute(code, nf, nt);
    if (!computed) return null;
    // Days are grouped in the ORG's zone, the same clock the hours are judged in: a
    // 21:00 slot is stored as the next day in UTC, and grouping in UTC would spend
    // one of the days on a day the customer does not have.
    const { zone } = await deps.businessHours();
    const fresh: BucketSlots = mapSlotLists(computed, (list) =>
      trimToBookableDays(list, zone, horizonDays),
    );
    // A refused or failed write must not take the lead's times with it: this is the
    // fail-open path, and the computed answer is correct whether or not it was
    // stored. It is labelled with when the compute began, the stamp the row would
    // have had.
    let computedAt: string;
    try {
      const written = await deps.writeRow(code, fresh, computeStartedMs);
      if (written === SUPERSEDED_BY_SAVE) {
        if (attempt === 0) continue;
        return served({ ...fresh, computedAt: new Date(computeStartedMs).toISOString() }, "compute");
      }
      computedAt = written;
    } catch (err) {
      deps.writeFailed(code, err);
      computedAt = new Date(computeStartedMs).toISOString();
    }
    const cached: CachedBucketSlots = { ...fresh, computedAt };
    await deps.cachePut(key, cached);
    return served(cached, "compute");
  }
}

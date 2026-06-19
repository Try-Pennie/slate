import { slotCacheKey } from "./cache-key.ts";
import { shapePrecomputedRow } from "./precompute-shape.ts";
import type { BucketSlots } from "./service";

/**
 * Dependency-injected read orchestration for the precompute path, so the core
 * invariant — NEVER run the multi-agent compute when a good answer already
 * exists — is unit-testable without Cloudflare/Supabase. The real IO deps are
 * bound in slot-cache.ts; this module imports only pure helpers + a type.
 */
export interface ReadDeps {
  /** L1: per-colo Cache API lookup by key. */
  cacheGet(key: string): Promise<BucketSlots | null>;
  /** L1 write-through (best-effort). */
  cachePut(key: string, val: BucketSlots): Promise<void>;
  /** L2: the precomputed bucket_slots row. */
  readRow(code: string): Promise<{ payload: unknown } | null>;
  /** Bounded fail-open: the live multi-agent compute (rare). */
  compute(code: string, fromIso: string, toIso: string): Promise<BucketSlots | null>;
  /** Self-heal: persist a freshly computed blob. */
  writeRow(code: string, val: BucketSlots): Promise<void>;
}

/**
 * Cache API -> precomputed row -> bounded fail-open compute. Returns the same
 * BucketSlots the legacy path returned (response shape unchanged), or null for
 * an unknown bucket. The compute path runs ONLY when no good row exists.
 */
export async function resolveBucketSlots(
  code: string,
  fromIso: string,
  horizonDays: number,
  deps: ReadDeps,
): Promise<BucketSlots | null> {
  const { key, fromIso: nf, toIso: nt } = slotCacheKey(code, fromIso, horizonDays);

  const hit = await deps.cacheGet(key);
  if (hit) return hit;

  const row = shapePrecomputedRow(await deps.readRow(code));
  if (row) {
    await deps.cachePut(key, row);
    return row;
  }

  // Never-computed / malformed row: compute live once and self-heal.
  const fresh = await deps.compute(code, nf, nt);
  if (fresh) {
    await deps.writeRow(code, fresh);
    await deps.cachePut(key, fresh);
  }
  return fresh;
}

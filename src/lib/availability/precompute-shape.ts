import type { BucketSlots } from "./service";

/**
 * SPIKE (spike/precompute-bucket-slots). Pure: turn a stored bucket_slots row
 * into a BucketSlots, or null if the row is missing or malformed. A malformed
 * row is treated as a MISS so the route falls back to the live compute path
 * rather than serving a broken payload. Kept import-free (type-only) so it is
 * unit-testable under node --experimental-strip-types.
 */
export function shapePrecomputedRow(
  row: { payload: unknown } | null,
): BucketSlots | null {
  if (!row || typeof row.payload !== "object" || row.payload === null) return null;
  const p = row.payload as Record<string, unknown>;
  if (!p.bucket || !p.eventType || typeof p.orgName !== "string" || !Array.isArray(p.slots)) {
    return null;
  }
  return p as unknown as BucketSlots;
}

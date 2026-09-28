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
  const shaped = p as unknown as BucketSlots;
  // #2842: a malformed second list is dropped rather than failing the row. Absent
  // reads as UNKNOWN, which the cascade treats as "nobody without Low", so the
  // worst case is one rung offering nobody until the next recompute; failing the
  // row would instead send the whole bucket to the live compute path.
  if ("slotsWithoutLow" in p && !isStringArray(p.slotsWithoutLow)) {
    const { slotsWithoutLow: _dropped, ...rest } = shaped;
    return rest;
  }
  return shaped;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Apply one slot list transform to BOTH lists a pool carries (#2842).
 *
 * Every step that shapes `slots` (the business hours filter on read, the bookable
 * day trim on write) goes through here, so the list a top tier lead's cascade
 * reads cannot miss a step the main list gets. An absent second list stays
 * absent: turning it into an empty one would change "unknown" into "nobody is
 * free", and those mean different things to the reader.
 */
export function mapSlotLists<T extends BucketSlots>(v: T, f: (slots: string[]) => string[]): T {
  const { slotsWithoutLow, ...rest } = v;
  return {
    ...rest,
    slots: f(v.slots),
    ...(slotsWithoutLow !== undefined ? { slotsWithoutLow: f(slotsWithoutLow) } : {}),
  } as T;
}

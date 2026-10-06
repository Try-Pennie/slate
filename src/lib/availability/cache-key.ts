import { searchWindowDays } from "./bookable-days.ts";

/**
 * The edge (L1) cache key for a bucket's slots: ONE key per bucket, whatever `from`
 * the caller sent (#3366).
 *
 * The cached value is the bucket's stored row, which does not depend on `from` at
 * all, so `from` has no business in the key. It used to be there, anchored to the
 * UTC day of `from`, and that made a key per caller's day while every purge
 * (`invalidateBucketSlots`, the recompute's own drop, a booking's splice) deleted
 * only the key for the UTC day of NOW. The booker sends the lead's LOCAL midnight,
 * which from about 8 PM Eastern is yesterday's UTC date, so an evening lead's entry
 * sat under a key nothing ever deleted. With no day in the key, the one key every
 * reader writes is the one every purge deletes, including across UTC midnight.
 *
 * `horizonDays` stays in the key because it names what the entry was computed over.
 * Bump the version prefix after a compute-logic change. v5 dropped the day.
 */
export function slotCacheEntryKey(bucketCode: string, horizonDays: number): string {
  return `slots:v5:${bucketCode}:${horizonDays}`;
}

/**
 * The entry key plus the normalized window to COMPUTE over, anchored to the start
 * of the UTC day of `fromIso`. The window is only used when there is no stored row
 * to serve (a cold compute) and by the recompute paths, which pass now.
 *
 * `horizonDays` is a count of BOOKABLE days (#1326), not calendar days, so the
 * computed window reaches further than the number asked for: closed days inside it
 * would otherwise eat into the answer and the booker would offer fewer choices for
 * a reason no customer can see. `searchWindowDays` owns how much further, and is
 * deliberately bounded because recompute cost grows with the window.
 */
export function slotCacheKey(
  bucketCode: string,
  fromIso: string,
  horizonDays: number,
): { key: string; fromIso: string; toIso: string } {
  const d = new Date(fromIso);
  d.setUTCHours(0, 0, 0, 0);
  const anchorFrom = d.toISOString();
  const toIso = new Date(
    d.getTime() + searchWindowDays(horizonDays) * 86_400_000,
  ).toISOString();
  return { key: slotCacheEntryKey(bucketCode, horizonDays), fromIso: anchorFrom, toIso };
}

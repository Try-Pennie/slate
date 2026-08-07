import { searchWindowDays } from "./bookable-days.ts";

/**
 * Cache key + the normalized window to compute. Anchoring `from` to the start of
 * the UTC day gives ONE key per bucket per day, so the Cache API (which has no
 * prefix-list) can invalidate a bucket with a single exact delete. Bump the
 * version prefix after a compute-logic change.
 *
 * `horizonDays` is a count of BOOKABLE days (#1326), not calendar days, so the
 * computed window reaches further than the number asked for: closed days inside it
 * would otherwise eat into the answer and the booker would offer fewer choices for
 * a reason no customer can see. `searchWindowDays` owns how much further, and is
 * deliberately bounded because recompute cost grows with the window.
 *
 * The version moved to v4 with that change. A v3 entry was computed over exactly
 * `horizonDays` calendar days, so serving one now would silently hand back the old
 * short answer under the new setting's name.
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
  return { key: `slots:v4:${bucketCode}:${anchorFrom}:${horizonDays}`, fromIso: anchorFrom, toIso };
}

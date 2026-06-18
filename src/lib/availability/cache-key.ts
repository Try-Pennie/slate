/** Cache key + the normalized window to compute. Anchoring `from` to the start
 *  of the UTC day gives ONE key per bucket per day, so the Cache API (which has
 *  no prefix-list) can invalidate a bucket with a single exact delete. Bump the
 *  `v2` prefix after a compute-logic change. */
export function slotCacheKey(
  bucketCode: string,
  fromIso: string,
  horizonDays: number,
): { key: string; fromIso: string; toIso: string } {
  const d = new Date(fromIso);
  d.setUTCHours(0, 0, 0, 0);
  const anchorFrom = d.toISOString();
  const toIso = new Date(d.getTime() + horizonDays * 86_400_000).toISOString();
  return { key: `slots:v2:${bucketCode}:${anchorFrom}:${horizonDays}`, fromIso: anchorFrom, toIso };
}

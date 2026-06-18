/** Cache key + the normalized window to compute, so all requests within one
 *  UTC hour share a cache entry. Bump the `v1` prefix to invalidate all keys
 *  after a compute-logic change. */
export function slotCacheKey(
  bucketCode: string,
  fromIso: string,
  horizonDays: number,
): { key: string; fromIso: string; toIso: string } {
  const d = new Date(fromIso);
  d.setUTCMinutes(0, 0, 0);
  const roundedFrom = d.toISOString();
  const toIso = new Date(d.getTime() + horizonDays * 86_400_000).toISOString();
  return { key: `slots:v1:${bucketCode}:${roundedFrom}:${horizonDays}`, fromIso: roundedFrom, toIso };
}

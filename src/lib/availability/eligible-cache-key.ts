/**
 * Pure cache-key helpers for the 60-second eligible-agent-set cache (#421).
 * No @/ imports — loadable directly by node-native tests.
 */

/** 60-second TTL: short enough to reflect pool changes within one cron cycle,
 *  long enough for all monitoring/precompute lanes in a single tick to share
 *  the same eligibility read rather than each re-querying the DB. */
export const ELIGIBLE_TTL_SECONDS = 60;

/**
 * Cache key for a bucket's eligible-agent set.
 * Keyed by bucket id (org-unique UUID), not bucket code, so the key is stable
 * across any code renames and avoids any code-format ambiguity.
 *
 * v2 (#3388): an entry is `{ agents, readAtMs }` rather than the bare list. The
 * version moved with the shape so that during a deploy an isolate still running
 * the old code never reads the new shape as a list with no `ids`, and the new
 * code never reads an old entry it cannot date.
 */
export function eligibleCacheKey(bucketId: string): string {
  return `eligible:v2:${bucketId}`;
}

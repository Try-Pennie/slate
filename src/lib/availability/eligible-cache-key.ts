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
 */
export function eligibleCacheKey(bucketId: string): string {
  return `eligible:v1:${bucketId}`;
}

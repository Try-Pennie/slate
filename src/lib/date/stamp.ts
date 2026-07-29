/**
 * Parsing for STORED timestamps (heartbeats, cooldowns, expirations, cache
 * freshness). Dependency-free on purpose: it is imported by pure modules
 * (sync-pace, alerts) whose node tests run without a DOM or framework.
 */

/**
 * Parse a stored timestamp to finite epoch ms, or null when there is nothing to
 * parse or it cannot be parsed. NEVER returns NaN (#1169): a NaN compares false
 * against every threshold, so at a monitoring comparison it silently lands on
 * the HEALTHY side (not stale, not due, inside cooldown, not due for retry).
 * Callers map null to their own fail-safe side: stale for a heartbeat, due for
 * a watch expiration or webhook retry, "never sent" for an alert cooldown.
 */
export function parseStampMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

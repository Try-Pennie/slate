/**
 * Pure health-status decision for the unauthenticated /api/health endpoint (#595).
 *
 * PURE: node-native-testable, no imports. The route (health/route.ts) does the DB
 * ping + heartbeat reads, then hands the raw signals here to decide 200 vs 503.
 *
 * A never-stamped set of lanes (no heartbeat rows yet, e.g. a fresh deploy before
 * the first cron tick) yields `mostStaleAgeMs === null` and must NOT fail health,
 * matching isHeartbeatStale's "do not alert on an uninitialized lane" rule.
 */
export interface HealthInput {
  /** Did the cheap DB liveness query succeed? */
  dbOk: boolean;
  /** Age (ms) of the most-stale heartbeat across all lanes, or null if none exist. */
  mostStaleAgeMs: number | null;
  /** A lane older than this (strict >) is considered stale. */
  maxStaleMs: number;
}

export type HealthReason = "ok" | "db_unreachable" | "heartbeat_stale";

export interface HealthResult {
  healthy: boolean;
  httpStatus: 200 | 503;
  reason: HealthReason;
}

export function computeHealthStatus(input: HealthInput): HealthResult {
  if (!input.dbOk) {
    return { healthy: false, httpStatus: 503, reason: "db_unreachable" };
  }
  if (input.mostStaleAgeMs !== null && input.mostStaleAgeMs > input.maxStaleMs) {
    return { healthy: false, httpStatus: 503, reason: "heartbeat_stale" };
  }
  return { healthy: true, httpStatus: 200, reason: "ok" };
}

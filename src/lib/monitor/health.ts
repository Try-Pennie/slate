/**
 * Pure health-status decision for the unauthenticated /api/health endpoint
 * (#595, extended to a multi-lane dead-man's switch in #685).
 *
 * PURE: node-native-testable, no imports. The route (health/route.ts) does the DB
 * ping + heartbeat reads, then hands the raw per-lane ages here to decide 200 vs
 * 503.
 *
 * A never-stamped lane (ageMs === null, no heartbeat row yet, e.g. a fresh
 * deploy before that lane's first tick) must NOT fail health, matching
 * isHeartbeatStale's "do not alert on an uninitialized lane" rule.
 */

const MIN = 60_000;

/**
 * Per-lane staleness bounds for the multi-lane dead-man's switch (#685). Each
 * covered cron lane stamps a heartbeat on a successful tick (recordHeartbeat);
 * health flips to 503 when a lane's heartbeat is older than its OWN bound here.
 *
 * Bounds are generous multiples of each lane's cadence so ordinary Cloudflare
 * cron jitter or a single slow tick can't trip a false 503; only a lane that
 * has genuinely stopped does. Cadences come from worker/cron-routes.ts:
 *   every minute : sync, recompute, outbox, selfheal  -> 10 min bound
 *   every 5 min  : complete, watch, monitor           -> 20 min bound
 *
 * The hourly `agents` lane is intentionally NOT covered: at a 60-min cadence a
 * heartbeat bound is noisy, and a stalled roster sync is already surfaced by its
 * own alert path. Acceptance for #685 scopes coverage to the 1-min and 5-min
 * lanes only.
 */
export const LANE_STALE_BOUNDS_MS: Record<string, number> = {
  sync: 10 * MIN,
  recompute: 10 * MIN,
  outbox: 10 * MIN,
  selfheal: 10 * MIN,
  complete: 20 * MIN,
  watch: 20 * MIN,
  monitor: 20 * MIN,
};

export interface LaneObservation {
  lane: string;
  /** Age (ms) since this lane last stamped, or null if it has never stamped. */
  ageMs: number | null;
  /** This lane is stale (unhealthy) when ageMs > maxStaleMs (strict >). */
  maxStaleMs: number;
}

export interface HealthInput {
  /** Did the cheap DB liveness query succeed? */
  dbOk: boolean;
  /** One entry per covered lane, with its own staleness bound. */
  lanes: LaneObservation[];
}

export type HealthReason = "ok" | "db_unreachable" | "heartbeat_stale";

export interface HealthResult {
  healthy: boolean;
  httpStatus: 200 | 503;
  reason: HealthReason;
  /** The offending lane when reason === "heartbeat_stale", else null. */
  staleLane: string | null;
  /** That lane's age (ms) when reason === "heartbeat_stale", else null. */
  staleAgeMs: number | null;
}

export function computeHealthStatus(input: HealthInput): HealthResult {
  if (!input.dbOk) {
    return {
      healthy: false,
      httpStatus: 503,
      reason: "db_unreachable",
      staleLane: null,
      staleAgeMs: null,
    };
  }

  // A lane is stale when it has stamped at least once (ageMs !== null) AND its
  // age exceeds its own bound (strict >). Never-stamped lanes don't alarm. When
  // several lanes are stale, report the one MOST over its bound: with
  // heterogeneous bounds that is the most-broken lane, not merely the oldest.
  let worst: { lane: string; ageMs: number; over: number } | null = null;
  for (const l of input.lanes) {
    if (l.ageMs === null) continue;
    const over = l.ageMs - l.maxStaleMs;
    if (over > 0 && (worst === null || over > worst.over)) {
      worst = { lane: l.lane, ageMs: l.ageMs, over };
    }
  }

  if (worst) {
    return {
      healthy: false,
      httpStatus: 503,
      reason: "heartbeat_stale",
      staleLane: worst.lane,
      staleAgeMs: worst.ageMs,
    };
  }

  return { healthy: true, httpStatus: 200, reason: "ok", staleLane: null, staleAgeMs: null };
}

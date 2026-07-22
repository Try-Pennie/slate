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

/**
 * Staleness bound for the external booking-smoke canary (#525), kept SEPARATE
 * from LANE_STALE_BOUNDS_MS on purpose. The canary is a scheduled GitHub Actions
 * workflow, not a Worker cron lane: a stopped canary means the safety net went
 * quiet, NOT that the app is down, so it must never flip the external /api/health
 * 503 (that pages external uptime as if the site were broken). Only the internal
 * lane-watchdog consults this, alerting to Slack.
 *
 * The canary stamps `smoke-canary` on every successful run (the ~30-min
 * side-effect-free dry tick and the 6h full pass both stamp). The bound is 3x the
 * frequent cadence so ordinary GitHub scheduling jitter (scheduled runs are often
 * delayed several minutes) can't trip a false alert; only a schedule that has
 * genuinely stopped, or is failing before it can stamp, does.
 *
 * `smoke-canary-full` is tracked SEPARATELY (#982). The dry tick and the full pass
 * used to share the one `smoke-canary` stamp, so the 30-min dry tick kept it fresh
 * and a silently-dropped 6h full run (the only automated proof a booking can
 * actually be created, rescheduled, and cancelled) never went stale and never
 * paged. The full pass now stamps its own heartbeat, judged against an 8h bound:
 * above the 6h cadence and the 6h30m gap-fill trigger, so the Worker gap-filler
 * normally re-runs the full pass before this backstop pages, and only a full pass
 * that both GitHub AND the gap-filler have failed to complete trips it.
 */
export const CANARY_STALE_BOUNDS_MS: Record<string, number> = {
  "smoke-canary": 90 * MIN,
  "smoke-canary-full": 8 * 60 * MIN,
};

export interface StaleLane {
  lane: string;
  /** How long this lane has been quiet (ms). */
  ageMs: number;
  /** The bound it blew through. */
  maxStaleMs: number;
}

/**
 * Every covered lane that has gone quiet, worst offender first (#803).
 *
 * A cron invocation killed mid-run (`exceededCpu`) CANNOT report its own death,
 * so absence is the only in-band signal: the lanes that had not finished simply
 * never stamp. That is what this detects, and it is cause-agnostic: a CPU kill,
 * a crash, a stuck lock and a bad deploy all surface the same way.
 *
 * Judges each lane against its OWN cadence bound (a 5-min lane quiet for 12 min
 * is fine; a 1-min lane quiet for 12 min is not), and never alarms on a lane that
 * has never stamped: that is a fresh deploy before its first tick, not a death.
 * Alerting there would page on every deploy and train people to ignore it.
 *
 * PURE, so it is node-testable (scripts/test-stale-lanes.ts). Where
 * computeHealthStatus reports only the single worst lane (it drives one 200/503),
 * an alert wants EVERY quiet lane, since a CPU kill takes out several at once.
 */
export function findStaleLanes(
  lastRanAtMsByLane: Record<string, number | null | undefined>,
  nowMs: number,
  bounds: Record<string, number> = LANE_STALE_BOUNDS_MS,
): StaleLane[] {
  const stale: StaleLane[] = [];
  for (const [lane, maxStaleMs] of Object.entries(bounds)) {
    const lastRanAtMs = lastRanAtMsByLane[lane];
    if (lastRanAtMs === null || lastRanAtMs === undefined) continue;
    const ageMs = nowMs - lastRanAtMs;
    if (ageMs > maxStaleMs) stale.push({ lane, ageMs, maxStaleMs });
  }
  // Most-overdue first, so the alert leads with the worst offender.
  return stale.sort((a, b) => b.ageMs - b.maxStaleMs - (a.ageMs - a.maxStaleMs));
}

export type LaneHealthState = "ok" | "stale" | "never";

export interface LaneHealthRow {
  lane: string;
  /** Age (ms) since this lane last stamped, or null if it has never stamped. */
  ageMs: number | null;
  /** ok = stamped within its bound; stale = overdue; never = no heartbeat yet. */
  state: LaneHealthState;
  /** The lane's own staleness bound (ms). */
  maxStaleMs: number;
}

/**
 * Per-lane health rows for the in-app admin strip (#288), in a fixed canonical
 * order (bounds order) so the operator learns each lane's position. Reuses the
 * SAME bounds as the dead-man's switch (findStaleLanes / computeHealthStatus), so
 * the admin view and the pager can never disagree about what "stale" means. A
 * heartbeat is stamped only on a SUCCESSFUL tick, so `state` is the in-app
 * outcome: ok = ran fine recently, stale = wedged/erroring/not firing, never = no
 * tick since deploy (benign, matches the watchdog's "don't alarm on uninitialized").
 * PURE, so it is node-testable.
 */
export function classifyLaneHealth(
  lastRanAtMsByLane: Record<string, number | null | undefined>,
  nowMs: number,
  bounds: Record<string, number> = LANE_STALE_BOUNDS_MS,
): LaneHealthRow[] {
  return Object.entries(bounds).map(([lane, maxStaleMs]) => {
    const lastRanAtMs = lastRanAtMsByLane[lane];
    if (lastRanAtMs === null || lastRanAtMs === undefined) {
      return { lane, ageMs: null, state: "never", maxStaleMs };
    }
    const ageMs = nowMs - lastRanAtMs;
    return { lane, ageMs, state: ageMs > maxStaleMs ? "stale" : "ok", maxStaleMs };
  });
}

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

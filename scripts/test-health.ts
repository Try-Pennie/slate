// TDD test for the pure computeHealthStatus helper (#595, extended for #685).
// The /api/health route's 503-vs-200 decision lives here so it is node-testable
// (the route's DB/heartbeat IO uses the @/ alias and cannot be node-tested).
// #685: the check is now MULTI-LANE (each covered cron lane has its own
// staleness bound), so a single global threshold no longer models it.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-health.ts
import {
  computeHealthStatus,
  LANE_STALE_BOUNDS_MS,
  type LaneObservation,
} from "../src/lib/monitor/health.ts";
import { assert, finish } from "./lib/harness.ts";

const MIN = 60_000;
const MINUTE_BOUND = 10 * MIN; // 1-min lanes (sync/recompute/outbox/selfheal)
// The absurd "age" an epoch-0 stamp produces: roughly 29.8 million minutes.
const NOW_MS = 1_800_000_000_000;
const FIVE_MIN_BOUND = 20 * MIN; // 5-min lanes (complete/watch/monitor)

// Every covered lane fresh -> 200 ok.
const allFresh: LaneObservation[] = [
  { lane: "sync", ageMs: 30_000, maxStaleMs: MINUTE_BOUND },
  { lane: "monitor", ageMs: 2 * MIN, maxStaleMs: FIVE_MIN_BOUND },
];
const healthy = computeHealthStatus({ dbOk: true, lanes: allFresh });
assert(
  healthy.healthy && healthy.httpStatus === 200 && healthy.reason === "ok",
  "db ok + all lanes fresh -> 200 ok",
);
assert(healthy.staleLane === null && healthy.staleAgeMs === null, "healthy result names no stale lane");

// Acceptance (#685): a NON-monitor lane going stale -> 503, naming that lane.
const syncStale = computeHealthStatus({
  dbOk: true,
  lanes: [
    { lane: "sync", ageMs: 12 * MIN, maxStaleMs: MINUTE_BOUND },
    { lane: "monitor", ageMs: 1 * MIN, maxStaleMs: FIVE_MIN_BOUND },
  ],
});
assert(
  !syncStale.healthy && syncStale.httpStatus === 503 && syncStale.reason === "heartbeat_stale",
  "a stale non-monitor lane -> 503 heartbeat_stale",
);
assert(
  syncStale.staleLane === "sync" && syncStale.staleAgeMs === 12 * MIN,
  "503 names the stale lane (sync) and its age",
);

// Per-lane bounds: a 5-min lane at 16m is WITHIN its 20m bound (healthy) while a
// 1-min lane at 12m is OVER its 10m bound (stale). A single global threshold
// could not tell these apart; this proves the thresholds are per-lane.
const perLane = computeHealthStatus({
  dbOk: true,
  lanes: [
    { lane: "watch", ageMs: 16 * MIN, maxStaleMs: FIVE_MIN_BOUND },
    { lane: "recompute", ageMs: 12 * MIN, maxStaleMs: MINUTE_BOUND },
  ],
});
assert(
  !perLane.healthy && perLane.reason === "heartbeat_stale" && perLane.staleLane === "recompute",
  "per-lane bounds: 1-min lane trips while the older 5-min lane stays healthy",
);

// Most-over-bound lane wins the report (not merely the oldest age): the watch
// lane is older in absolute terms but only 1m over its bound, while sync is 5m
// over its tighter bound -> report sync.
const worstOver = computeHealthStatus({
  dbOk: true,
  lanes: [
    { lane: "watch", ageMs: 21 * MIN, maxStaleMs: FIVE_MIN_BOUND }, // 1m over
    { lane: "sync", ageMs: 15 * MIN, maxStaleMs: MINUTE_BOUND }, // 5m over
  ],
});
assert(worstOver.staleLane === "sync", "most-over-bound lane is reported, not the oldest by age");

// DB unreachable takes precedence over any heartbeat state -> 503.
const dbDown = computeHealthStatus({
  dbOk: false,
  lanes: [{ lane: "sync", ageMs: 99 * MIN, maxStaleMs: MINUTE_BOUND }],
});
assert(
  !dbDown.healthy && dbDown.httpStatus === 503 && dbDown.reason === "db_unreachable",
  "db unreachable -> 503 db_unreachable (precedence)",
);

// No lane has ever stamped (fresh deploy) -> null ages must NOT fail health.
const noLanes = computeHealthStatus({
  dbOk: true,
  lanes: [
    { lane: "sync", ageMs: null, maxStaleMs: MINUTE_BOUND },
    { lane: "monitor", ageMs: null, maxStaleMs: FIVE_MIN_BOUND },
  ],
});
assert(
  noLanes.healthy && noLanes.httpStatus === 200,
  "no heartbeats yet (all null) -> 200, not a false 503",
);

// Exactly at a lane's threshold is NOT stale (strict >), matching isHeartbeatStale.
const atThreshold = computeHealthStatus({
  dbOk: true,
  lanes: [{ lane: "sync", ageMs: MINUTE_BOUND, maxStaleMs: MINUTE_BOUND }],
});
assert(
  atThreshold.healthy && atThreshold.httpStatus === 200,
  "exactly at threshold -> 200 (strict >)",
);

// #1172: a lane whose stored stamp could not be READ still fails closed (503),
// but the body must not publish the arithmetic that follows from the epoch-0
// sentinel as if it were a measured age. A reader of this endpoint gets the fact
// (the record is unreadable) and no age at all, because none was measured.
{
  const unreadable = computeHealthStatus({
    dbOk: true,
    lanes: [
      { lane: "sync", ageMs: 30_000, maxStaleMs: MINUTE_BOUND },
      { lane: "monitor", ageMs: NOW_MS, maxStaleMs: FIVE_MIN_BOUND, stampUnreadable: true },
    ],
  });
  assert(
    !unreadable.healthy && unreadable.httpStatus === 503,
    "an unreadable stamp still fails closed with a 503",
  );
  assert(unreadable.staleLane === "monitor", "and names the lane whose record could not be read");
  assert(
    unreadable.staleStampUnreadable === true,
    "the body says the stamp was unreadable, so a reader is not left guessing",
  );
  assert(
    unreadable.staleAgeMs === null,
    "and reports NO age, because an unreadable stamp measures no age",
  );

  // A genuinely quiet lane is unchanged: it has a real age and says so.
  const genuinelyStale = computeHealthStatus({
    dbOk: true,
    lanes: [{ lane: "sync", ageMs: 12 * MIN, maxStaleMs: MINUTE_BOUND }],
  });
  assert(
    genuinelyStale.staleAgeMs === 12 * MIN && genuinelyStale.staleStampUnreadable === false,
    "a real staleness still reports its measured age and is not flagged unreadable",
  );
}

// The shipped config covers every 1-min and 5-min lane and excludes agents.
for (const lane of ["sync", "recompute", "outbox", "selfheal", "complete", "watch", "monitor"]) {
  assert(typeof LANE_STALE_BOUNDS_MS[lane] === "number", `LANE_STALE_BOUNDS_MS covers "${lane}"`);
}
assert(
  LANE_STALE_BOUNDS_MS["agents"] === undefined,
  "hourly agents lane is intentionally excluded from the health check",
);

finish();

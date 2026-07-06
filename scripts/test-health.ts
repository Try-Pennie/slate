// TDD test for the pure computeHealthStatus helper (#595).
// The /api/health route's 503-vs-200 decision lives here so it is node-testable
// (the route's DB/heartbeat IO uses the @/ alias and cannot be node-tested).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-health.ts
import { computeHealthStatus } from "../src/lib/monitor/health.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else {
    console.log("ok:", msg);
  }
}

const MIN = 60_000;
const MAX_STALE = 15 * MIN;

// Healthy: DB reachable, freshest lane well within threshold.
const healthy = computeHealthStatus({ dbOk: true, mostStaleAgeMs: 5 * MIN, maxStaleMs: MAX_STALE });
assert(healthy.healthy && healthy.httpStatus === 200 && healthy.reason === "ok", "db ok + fresh heartbeat -> 200 ok");

// Stale heartbeat (the suggested test): most-stale lane older than threshold -> 503.
const stale = computeHealthStatus({ dbOk: true, mostStaleAgeMs: 20 * MIN, maxStaleMs: MAX_STALE });
assert(!stale.healthy && stale.httpStatus === 503 && stale.reason === "heartbeat_stale", "stale heartbeat -> 503 heartbeat_stale");

// DB unreachable takes precedence over any heartbeat state -> 503.
const dbDown = computeHealthStatus({ dbOk: false, mostStaleAgeMs: 1 * MIN, maxStaleMs: MAX_STALE });
assert(!dbDown.healthy && dbDown.httpStatus === 503 && dbDown.reason === "db_unreachable", "db unreachable -> 503 db_unreachable (precedence)");

// No lanes have ever stamped (fresh deploy) -> null age must NOT fail health.
const noLanes = computeHealthStatus({ dbOk: true, mostStaleAgeMs: null, maxStaleMs: MAX_STALE });
assert(noLanes.healthy && noLanes.httpStatus === 200, "no heartbeats yet (null) -> 200, not a false 503");

// Exactly at threshold is NOT stale (strict >), matching isHeartbeatStale.
const atThreshold = computeHealthStatus({ dbOk: true, mostStaleAgeMs: MAX_STALE, maxStaleMs: MAX_STALE });
assert(atThreshold.healthy && atThreshold.httpStatus === 200, "exactly at threshold -> 200 (strict >)");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

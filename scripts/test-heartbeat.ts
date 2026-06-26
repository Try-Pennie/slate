// TDD test for the pure isHeartbeatStale helper (#420).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-heartbeat.ts
import { isHeartbeatStale } from "../src/lib/monitor/heartbeat.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else {
    console.log("ok:", msg);
  }
}

const now = 1_000_000_000_000; // arbitrary fixed ms
const MIN = 60_000;
const THRESHOLD = 15 * MIN;

assert(!isHeartbeatStale(null, now, THRESHOLD), "null lastRanAt (never stamped) -> not stale");
assert(!isHeartbeatStale(now - 1 * MIN, now, THRESHOLD), "1 min ago, threshold 15 min -> not stale");
assert(isHeartbeatStale(now - 20 * MIN, now, THRESHOLD), "20 min ago, threshold 15 min -> stale");
assert(!isHeartbeatStale(now - THRESHOLD, now, THRESHOLD), "exactly at threshold -> NOT stale (strict >)");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

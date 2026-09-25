// The external uptime checks' heartbeats are watched, and their bound is DERIVED
// from how noodge runs them (#1228).
//
// noodge polls /api/health and /api/health/availability every five minutes and
// each request carrying the heartbeat key stamps a lane. The bound has to clear
// the longest silence a HEALTHY noodge can leave without alerting on its own, or
// a transport blip noodge is quietly retrying pages here as "noodge stopped". It
// must not sit far above that either, or a deleted check goes unnoticed for hours.
//
// So this re-derives that silence from the cadence Slate says noodge runs with
// (`NOODGE_SLATE_CHECK`, the mirror of `monitors/slate.sql` in Try-Pennie/noodge,
// whose own verifier asserts the same four numbers) and holds the bound between it
// and it plus two check intervals.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-uptime-heartbeat-bounds.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NOODGE_SLATE_CHECK,
  UPTIME_STALE_BOUNDS_MS,
  LANE_STALE_BOUNDS_MS,
} from "../src/lib/monitor/health.ts";
import { assert, finish } from "./lib/harness.ts";

const MIN = 60_000;
const c = NOODGE_SLATE_CHECK;

// The four numbers noodge is registered with. Changing one here without changing
// monitors/slate.sql (or the reverse) makes the bound a claim about a monitor that
// does not exist, so the values are pinned rather than merely read.
assert(c.intervalMin === 5, "noodge checks Slate every 5 minutes");
assert(c.alertAfter === 2, "noodge alerts after 2 consecutive failed runs");
assert(c.maxAttempts === 2, "noodge makes up to 2 attempts per run");
assert(c.timeoutMs === 20_000, "each noodge attempt times out at 20s");
assert(c.schedulerTickMs === MIN, "noodge's scheduler leases due checks once a minute");

// The longest stamp gap a running noodge leaves WITHOUT alerting: the stamped run,
// then alert_after minus one runs that never reached Slate (the next one alerts or
// stamps), each started up to one scheduler tick late and each taking up to every
// attempt's full timeout.
const longestQuietMs =
  c.alertAfter * c.intervalMin * MIN + c.schedulerTickMs + c.maxAttempts * c.timeoutMs;

const lanes = Object.keys(UPTIME_STALE_BOUNDS_MS).sort();
assert(
  JSON.stringify(lanes) === JSON.stringify(["uptime:api-health", "uptime:availability-canary"]),
  `the two checks that can stamp are both watched (got ${lanes.join(", ")})`,
);

for (const [lane, bound] of Object.entries(UPTIME_STALE_BOUNDS_MS)) {
  assert(
    bound > longestQuietMs,
    `${lane}: bound ${(bound / MIN).toFixed(1)}m clears the ${(longestQuietMs / MIN).toFixed(1)}m a healthy noodge can go quiet without alerting`,
  );
  assert(
    bound <= longestQuietMs + 2 * c.intervalMin * MIN,
    `${lane}: bound ${(bound / MIN).toFixed(1)}m is at most two check intervals over that, so a deleted check pages inside the half hour`,
  );
  // A stale monitor is not an outage. /api/health judges LANE_STALE_BOUNDS_MS
  // alone, so a lane here must never also be there, or a paused noodge check would
  // flip the endpoint noodge itself polls to 503.
  assert(!(lane in LANE_STALE_BOUNDS_MS), `${lane} is not a core lane, so it never flips /api/health`);
}

// The allowlist the helper stamps from names exactly the lanes watched here, read
// from its source so the two lists cannot drift apart unnoticed.
const helper = readFileSync(
  join(import.meta.dirname, "..", "src", "lib", "monitor", "uptime-heartbeat.ts"),
  "utf8",
);
const allow = /UPTIME_HEARTBEAT_LANES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(helper);
const allowed = allow ? [...allow[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort() : [];
assert(
  JSON.stringify(allowed) === JSON.stringify(lanes),
  `the stamping allowlist matches the watched lanes (allowlist: ${allowed.join(", ") || "none found"})`,
);

finish();

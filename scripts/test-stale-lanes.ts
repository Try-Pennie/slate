// TDD test for the pure findStaleLanes helper (#803).
//
// A cron invocation killed mid-run (exceededCpu) cannot report its own death:
// it is killed. So the only in-band signal is ABSENCE: the lanes that did not
// finish never stamp their heartbeat. This helper turns those heartbeat ages
// into "which lanes have gone quiet", which is what the alert fires on.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-stale-lanes.ts
import { findStaleLanes, LANE_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";

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
const NOW = 1_800_000_000_000;
const ago = (ms: number) => NOW - ms;

// --- Healthy fleet: every lane stamped recently -----------------------------
assert(
  findStaleLanes(
    {
      sync: ago(30_000),
      recompute: ago(30_000),
      outbox: ago(30_000),
      selfheal: ago(30_000),
      complete: ago(2 * MIN),
      watch: ago(2 * MIN),
      monitor: ago(2 * MIN),
    },
    NOW,
  ).length === 0,
  "no lane is stale when every lane stamped inside its bound",
);

// --- The #803 scenario: a CPU kill takes out the lanes that had not finished.
// sync ran (it is first), the later lanes in the same invocation never stamped.
const killed = findStaleLanes(
  {
    sync: ago(30_000),
    recompute: ago(25 * MIN),
    outbox: ago(25 * MIN),
    selfheal: ago(25 * MIN),
    complete: ago(2 * MIN),
    watch: ago(2 * MIN),
    monitor: ago(2 * MIN),
  },
  NOW,
);
assert(killed.length === 3, "reports EVERY lane that went quiet, not just the worst one");
assert(
  killed.map((l) => l.lane).sort().join(",") === "outbox,recompute,selfheal",
  "names exactly the lanes that stopped stamping",
);
assert(
  killed.every((l) => l.ageMs > l.maxStaleMs),
  "each reported lane is genuinely past its own bound",
);

// --- Per-lane bounds: a 5-min lane must not be judged by a 1-min lane's bound.
// 12 min quiet is stale for an every-minute lane (10 min bound) but FINE for a
// 5-min lane (20 min bound). One global threshold would false-alarm here.
const mixed = findStaleLanes({ sync: ago(12 * MIN), monitor: ago(12 * MIN) }, NOW);
assert(
  mixed.length === 1 && mixed[0].lane === "sync",
  "judges each lane against its OWN cadence bound, not a global one",
);

// --- Never-stamped lanes must not alarm (fresh deploy before the first tick),
// matching the isHeartbeatStale / computeHealthStatus rule. Alerting here would
// page on every deploy, which trains people to ignore the alert.
assert(
  findStaleLanes({ sync: null, recompute: ago(30_000) }, NOW).length === 0,
  "a lane that has NEVER stamped does not alarm (uninitialized, not dead)",
);
assert(
  findStaleLanes({}, NOW).length === 0,
  "a completely empty heartbeat table does not alarm (fresh deploy)",
);

// --- Only covered lanes are judged. The hourly agents lane is deliberately out
// of scope (its own alert path covers it); an unknown lane must not alarm.
assert(
  findStaleLanes({ agents: ago(5 * 60 * MIN), nonsense: ago(999 * MIN) }, NOW).length === 0,
  "uncovered lanes (agents, unknown) are ignored rather than alarmed on",
);

// --- Boundary: strictly greater than the bound, so a lane exactly at its bound
// is still healthy (cron jitter must not trip a false alarm).
assert(
  findStaleLanes({ sync: ago(LANE_STALE_BOUNDS_MS.sync) }, NOW).length === 0,
  "a lane exactly AT its bound is not stale (strict >)",
);
assert(
  findStaleLanes({ sync: ago(LANE_STALE_BOUNDS_MS.sync + 1) }, NOW).length === 1,
  "a lane one ms past its bound IS stale",
);

// --- Most-broken lane first, so the alert text leads with the worst offender.
const ordered = findStaleLanes({ sync: ago(11 * MIN), recompute: ago(60 * MIN) }, NOW);
assert(
  ordered[0].lane === "recompute",
  "the most-overdue lane is reported first",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

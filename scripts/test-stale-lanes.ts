// TDD test for the pure findStaleLanes helper (#803).
//
// A cron invocation killed mid-run (exceededCpu) cannot report its own death:
// it is killed. So the only in-band signal is ABSENCE: the lanes that did not
// finish never stamp their heartbeat. This helper turns those heartbeat ages
// into "which lanes have gone quiet", which is what the alert fires on.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-stale-lanes.ts
import {
  findStaleLanes,
  LANE_STALE_BOUNDS_MS,
  CANARY_STALE_BOUNDS_MS,
  RETENTION_STALE_BOUNDS_MS,
  retentionAlertText,
  neverStampedVerdict,
} from "../src/lib/monitor/health.ts";
import { assert, eq, finish } from "./lib/harness.ts";

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

// --- Canary bounds (#525, #982). The booking-smoke canary is judged against its
// OWN bounds, never the cron-lane bounds, so it can NEVER flip /api/health (a dead
// safety net is not the site being down). The full pass has its own, much longer
// bound than the 30-min dry tick, and both are kept OUT of LANE_STALE_BOUNDS_MS.
assert(
  typeof CANARY_STALE_BOUNDS_MS["smoke-canary"] === "number",
  "the dry canary tick has its own staleness bound",
);
assert(
  typeof CANARY_STALE_BOUNDS_MS["smoke-canary-full"] === "number",
  "the full canary pass has its OWN staleness bound (#982), so a dropped full run is not hidden by the dry tick",
);
assert(
  CANARY_STALE_BOUNDS_MS["smoke-canary-full"] > CANARY_STALE_BOUNDS_MS["smoke-canary"],
  "the full-pass bound is longer than the dry-tick bound (6h vs 30m cadence)",
);
assert(
  !("smoke-canary" in LANE_STALE_BOUNDS_MS) && !("smoke-canary-full" in LANE_STALE_BOUNDS_MS),
  "neither canary lane is in LANE_STALE_BOUNDS_MS, so neither can flip the external /api/health 503",
);
// The full-pass gap-fill trigger (6h30m) must fire before the watchdog bound (8h),
// so the pass is normally recovered before anyone is paged.
{
  const full = findStaleLanes(
    { "smoke-canary-full": ago(CANARY_STALE_BOUNDS_MS["smoke-canary-full"] + 1) },
    NOW,
    CANARY_STALE_BOUNDS_MS,
  );
  assert(
    full.length === 1 && full[0].lane === "smoke-canary-full",
    "a full-pass heartbeat past its bound is reported stale under the canary bounds",
  );
}

// --- the daily retention lanes (#1102) ----------------------------------------
// These destroy customer data, so a lane that has NEVER completed must not be
// invisible. By default findStaleLanes skips a never-stamped lane (a fresh deploy
// before its first tick), which would hide a lane that throws on every run since
// it never gets to stamp at all.
{
  const nothingStamped: Record<string, number | null> = {};
  const lenient = findStaleLanes(nothingStamped, NOW, RETENTION_STALE_BOUNDS_MS);
  assert(lenient.length === 0, "default leniency: a never-stamped lane is not reported (fresh deploy)");

  const strict = findStaleLanes(nothingStamped, NOW, RETENTION_STALE_BOUNDS_MS, true);
  assert(
    strict.length === Object.keys(RETENTION_STALE_BOUNDS_MS).length,
    "with neverIsStale, every retention lane that has never completed IS reported",
  );
  assert(
    strict.every((l) => !Number.isFinite(l.ageMs)),
    "a never-stamped lane reports an infinite age, which the alert copy special-cases",
  );
}
{
  // A lane inside its bound stays quiet even under neverIsStale.
  const fresh = Object.fromEntries(
    Object.keys(RETENTION_STALE_BOUNDS_MS).map((l) => [l, ago(60 * 60_000)]),
  );
  assert(
    findStaleLanes(fresh, NOW, RETENTION_STALE_BOUNDS_MS, true).length === 0,
    "a retention lane that completed an hour ago is well inside its 28h bound",
  );
  // ...and one past its bound is reported.
  const late = { ...fresh, "prune-bookings-pii": ago(RETENTION_STALE_BOUNDS_MS["prune-bookings-pii"] + 1) };
  const stale = findStaleLanes(late, NOW, RETENTION_STALE_BOUNDS_MS, true);
  assert(
    stale.length === 1 && stale[0].lane === "prune-bookings-pii",
    "a retention lane past its bound is reported, and only that one",
  );
}
assert(
  Object.keys(RETENTION_STALE_BOUNDS_MS).every((l) => !(l in LANE_STALE_BOUNDS_MS)),
  "no retention lane is in LANE_STALE_BOUNDS_MS, so stalled retention can never flip the external /api/health 503",
);

// --- a never-stamped lane needs a grace period, not an instant page ------------
// Turning neverIsStale on without this paged three lanes the moment #1136 deployed:
// the lanes run daily at 03:00 UTC, so between shipping the heartbeat code and the
// first scheduled run they had legitimately never stamped. The alert even told us
// they "failed every run or are not being scheduled", which was wrong. That is the
// cry-wolf failure the default leniency exists to prevent, so the strict mode needs
// its own window: record when we FIRST noticed the lane missing, and page only once
// it has been missing longer than its own bound.
{
  const BOUND = RETENTION_STALE_BOUNDS_MS["prune-routing"];
  eq(
    neverStampedVerdict(null, NOW, BOUND),
    "record-first-sighting",
    "the first time we see a lane missing we record it and do NOT page (it may have just deployed)",
  );
  eq(
    neverStampedVerdict(ago(BOUND - MIN), NOW, BOUND),
    "wait",
    "a lane missing for less than its bound stays quiet, so a deploy cannot page",
  );
  eq(
    neverStampedVerdict(ago(BOUND + MIN), NOW, BOUND),
    "page",
    "a lane still missing after its whole bound has elapsed IS genuinely broken",
  );
  eq(
    neverStampedVerdict(ago(BOUND), NOW, BOUND),
    "wait",
    "exactly at the bound is not yet stale (strict >), matching findStaleLanes",
  );
}

// The alert copy must name the consequence, not just the cron, and must handle the
// never-ran case without emitting a meaningless age.
{
  const never = retentionAlertText("prune-bookings-pii", Infinity, 1680);
  assert(never.includes("NEVER completed"), "never-ran copy says so explicitly");
  assert(!/Infinity|NaN/.test(never), "never-ran copy contains no meaningless age");
  assert(never.includes("contact data"), "never-ran copy names what is going unredacted");

  const late = retentionAlertText("prune-webhook-payloads", 30 * 60 * 60_000, 1680);
  assert(late.includes("1800 minutes"), "stale copy reports the measured age");
  assert(late.includes("attendee PII"), "stale copy names the consequence for this lane");
}

finish();

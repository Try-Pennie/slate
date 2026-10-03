// The cron lanes under fault, judged offline (#3104).
//
// Every case starts from the SAME passing series and breaks exactly one thing, so
// each finding is attributable to what it names, and the passing series itself is
// asserted to pass: a judge seen only to fail is satisfied by one that fails on
// everything (L1).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-fault-lanes.ts
import { readFileSync } from "node:fs";
import {
  faultLaneIncompleteness,
  judgeFaultLanes,
  lanesRunByDeployment,
  shortestBoundLanes,
  LANE_SAMPLER_MAX_MS,
  STALE_LANE_ALERT_PREFIX,
  SYNC_FAILURE_ALERT_KEY,
  type FaultLaneEvidence,
  type FaultLaneExpectations,
} from "./loadtest/fault-lanes.ts";
import { healthyFaultLanes, fixtureLaneExpectations } from "./lib/fault-lanes-fixture.ts";
import { scanAlertSites } from "./lib/scan-alert-keys.ts";
import { unstable_readConfig } from "wrangler";
import { disabledLanesOf, type WranglerLike } from "./lib/scan-wrangler-loadtest-env.ts";
import { LANE_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-03T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** Every lane stamping on its own cadence and one recorded page (the shared fixture). */
const healthy = (): FaultLaneEvidence => healthyFaultLanes(T0);
const EXPECT: FaultLaneExpectations = fixtureLaneExpectations(T0);

function findingsOf(e: FaultLaneEvidence, x: FaultLaneExpectations = EXPECT): string[] {
  const why = faultLaneIncompleteness(e, x);
  assert(why.length === 0, `the fixture is judgeable (${why.join(" | ")})`);
  return judgeFaultLanes(e, x).map((f) => f.detail);
}

// --- the passing series ---------------------------------------------------------
{
  eq(faultLaneIncompleteness(healthy(), EXPECT), [], "a full series is judgeable");
  eq(judgeFaultLanes(healthy(), EXPECT), [], "and lanes that kept running with one page pass");
}

// --- a lane that stopped ----------------------------------------------------------
{
  const e = healthy();
  for (const s of e.samples) if (s.atMs > T0 + MIN) s.heartbeats.outbox = iso(T0 - 9 * MIN);
  const f = findingsOf(e);
  assert(f.some((d) => d.includes("outbox lane was stale")), "a lane past its bound is named stale");
  assert(!f.some((d) => d.includes("sync lane")), "and only that lane");
}
{
  // Stale for a stretch and RECOVERED: invisible to one read at the end, which is
  // why the table is sampled.
  const e = healthy();
  for (const s of e.samples) {
    if (s.atMs > T0 + MIN && s.atMs < T0 + 3 * MIN) s.heartbeats.sync = iso(T0 - 10 * MIN);
  }
  assert(findingsOf(e).some((d) => d.includes("sync lane was stale")), "a lane that stalled and recovered is still caught");
}
{
  const e = healthy();
  for (const s of e.samples) delete s.heartbeats.complete;
  assert(findingsOf(e).some((d) => d.includes("complete lane has no heartbeat")), "a lane that never stamped never ran");
}
{
  const e = healthy();
  for (const s of e.samples) s.heartbeats.sync = "not a time";
  const f = findingsOf(e);
  assert(f.some((d) => d.includes("sync lane's heartbeat could not be read")), "an unreadable stamp is a finding, not fresh");
}
{
  // Fresh by its bound the whole time, and never ran in the window: the stamp from
  // before the faults began is what kept it looking alive.
  const e = healthy();
  for (const s of e.samples) s.heartbeats.sync = iso(T0 - 2 * MIN);
  const f = findingsOf(e);
  assert(f.some((d) => d.includes("sync lane did not stamp once")), "an every minute lane must run inside the window");
  assert(!f.some((d) => d.includes("sync lane was stale")), "even though no reading called it stale");
  // Control: the same frozen stamp on a lane NOT required to run in the window is fine.
  const g = healthy();
  for (const s of g.samples) s.heartbeats.complete = iso(T0 - 2 * MIN);
  eq(findingsOf(g), [], "a slower lane is held only to its bound");
}
{
  const e = healthy();
  for (const s of e.samples) {
    if (s.atMs >= T0 + 3 * MIN) s.alerts[`${STALE_LANE_ALERT_PREFIX}outbox`] = iso(T0 + 3 * MIN);
  }
  assert(
    findingsOf(e).some((d) => d.includes("watchdog paged that the outbox lane")),
    "the watchdog's own stale page is a finding",
  );
  const g = healthy();
  for (const s of g.samples) s.alerts[`${STALE_LANE_ALERT_PREFIX}monitor`] = iso(T0 + 3 * MIN);
  eq(findingsOf(g), [], "but not about a lane this deployment does not run");
  const h = healthy();
  for (const s of h.samples) s.alerts[`${STALE_LANE_ALERT_PREFIX}outbox`] = iso(T0 - 30 * MIN);
  eq(findingsOf(h), [], "nor a stale page from before the window");
}

// --- the page -----------------------------------------------------------------------
{
  const e = healthy();
  for (const s of e.samples) delete s.alerts[SYNC_FAILURE_ALERT_KEY];
  assert(
    findingsOf(e).some((d) => d.includes(`no ${SYNC_FAILURE_ALERT_KEY} page was recorded`)),
    "no page while calendar reads were failing is a finding",
  );
  eq(findingsOf(e, { ...EXPECT, syncPageExpected: false }), [], "unless calendar reads were not faulted");
}
{
  // The unthrottled shape: a fresh stamp every tick.
  const e = healthy();
  for (const s of e.samples) {
    if (s.atMs >= T0 + MIN) s.alerts[SYNC_FAILURE_ALERT_KEY] = iso(s.atMs - (s.atMs % MIN));
  }
  assert(findingsOf(e).some((d) => d.includes("it is not throttled")), "a page every tick is caught");
}
{
  const e = healthy();
  for (const s of e.samples) s.alerts[SYNC_FAILURE_ALERT_KEY] = iso(T0 - 20 * MIN);
  assert(
    findingsOf(e).some((d) => d.includes("no sync_failures page")),
    "a page from before the window does not count as firing in it",
  );
}

// --- incomplete evidence ------------------------------------------------------------
{
  const e = healthy();
  e.samples = e.samples.filter((s) => s.atMs < T0 + MIN || s.atMs > T0 + 3 * MIN);
  e.failedReads = 8;
  const why = faultLaneIncompleteness(e, EXPECT);
  assert(why.some((w) => w.includes("hole")), "a gap in the series is incomplete, never healthy");
  assert(why.some((w) => w.includes("8 reads failed")), "and it says the reads failed");
}
{
  const e = healthy();
  e.samples = e.samples.filter((s) => s.atMs > T0 + 2 * MIN);
  assert(faultLaneIncompleteness(e, EXPECT).some((w) => w.includes("start of the window")), "a late start is incomplete");
}
{
  const e = healthy();
  e.samples = e.samples.filter((s) => s.atMs < T0 + 2 * MIN);
  assert(faultLaneIncompleteness(e, EXPECT).some((w) => w.includes("end of the window")), "an early stop is incomplete");
}
{
  const e = healthy();
  e.finishedAtMs = T0 - 1;
  assert(faultLaneIncompleteness(e, EXPECT).some((w) => w.includes("before the fault driver started")), "a sampler that ended first saw nothing");
  const empty = { ...healthy(), samples: [] };
  assert(faultLaneIncompleteness(empty, EXPECT).some((w) => w.includes("0 readings")), "an empty series is incomplete");
}

// --- which lanes the deployment runs, as handed to the judge --------------------------
//
// The judge used to read wrangler.jsonc itself, which needed wrangler installed and the
// repo root as cwd, and threw after every driver had run, leaving no verdict. It is now
// a setting, and every way of not knowing is a reason the judge reports as incomplete.
{
  const bounds = { sync: 10 * MIN, monitor: 20 * MIN, complete: 20 * MIN };
  const known = ["sync", "monitor", "complete", "agents"];
  const ok = lanesRunByDeployment("monitor, agents", bounds, known);
  eq("lanes" in ok ? ok.lanes : null, { sync: 10 * MIN, complete: 20 * MIN }, "held back lanes are removed from what is judged");
  for (const missing of [undefined, "", " , "]) {
    const r = lanesRunByDeployment(missing, bounds, known);
    assert("why" in r && r.why.includes("EXPECT_LANES_DISABLED"), `an unset or blank setting (${JSON.stringify(missing)}) is a reason, not an empty list`);
  }
  const typo = lanesRunByDeployment("monitr", bounds, known);
  assert("why" in typo && typo.why.includes("monitr"), "a name that is no lane is a reason, naming it");
}
{
  // The workflow carries a COPY of env.loadtest's setting; it must be the same one.
  const yml = readFileSync(new URL("../.github/workflows/loadtest.yml", import.meta.url), "utf8");
  const m = /^\s*EXPECT_LANES_DISABLED:\s*(\S+)\s*$/m.exec(yml);
  assert(m !== null, "the load test workflow hands the judge EXPECT_LANES_DISABLED");
  const env = unstable_readConfig({ config: "wrangler.jsonc", env: "loadtest" }) as unknown as WranglerLike;
  eq(
    (m?.[1] ?? "").split(",").map((s) => s.trim()).sort(),
    disabledLanesOf(env).slice().sort(),
    "and it is exactly the lanes wrangler resolves env.loadtest as holding back",
  );
}

// --- the derived lists ---------------------------------------------------------------
{
  eq(
    shortestBoundLanes(LANE_STALE_BOUNDS_MS),
    ["outbox", "recompute", "selfheal", "sync"],
    "the lanes required to run in the window are the every minute lanes, derived from the bounds",
  );
}

// --- the keys are the ones the code really sends ---------------------------------------
//
// Read through the same scanner the alert recovery guard uses, so a rename of either
// key fails here rather than leaving the bar waiting for a page nothing sends (L96).
{
  const syncRoute = readFileSync(new URL("../src/app/api/cron/sync/route.ts", import.meta.url), "utf8");
  const sent = scanAlertSites(syncRoute, "sync/route.ts").filter((s) => s.channel === "alert").map((s) => s.key);
  assert(sent.includes(SYNC_FAILURE_ALERT_KEY), `the sync lane really pages on ${SYNC_FAILURE_ALERT_KEY} (saw ${sent.join(", ")})`);
  const watchdog = readFileSync(new URL("../src/lib/monitor/lane-watchdog.ts", import.meta.url), "utf8");
  const stale = scanAlertSites(watchdog, "lane-watchdog.ts").filter((s) => s.channel === "alert").map((s) => s.key);
  assert(stale.includes(`${STALE_LANE_ALERT_PREFIX}*`), `the watchdog really pages on ${STALE_LANE_ALERT_PREFIX}<lane>`);

  // "Throttled" is judged as at most ONE send per window, which is only right while
  // the page's cooldown is longer than any window the sampler can produce.
  const m = /const SYNC_ALERT_COOLDOWN_MS = ([\d\s*_]+);/.exec(syncRoute);
  assert(m !== null, "the sync page's cooldown is readable from the route");
  const cooldownMs = m
    ? m[1]!
        .split("*")
        .map((f) => Number(f.replace(/[_\s]/g, "")))
        .reduce((a, b) => a * b, 1)
    : 0;
  assert(
    cooldownMs > LANE_SAMPLER_MAX_MS,
    `the sync page's cooldown (${cooldownMs}ms) outlasts the longest window (${LANE_SAMPLER_MAX_MS}ms)`,
  );
}

finish();

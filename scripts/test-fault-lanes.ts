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
  faultLaneExpectationsFor,
  lanesRunByDeployment,
  shortestBoundLanes,
  LANE_SAMPLER_MAX_MS,
  STALE_LANE_ALERT_PREFIX,
  CORE_LANES_ALERT_KEY,
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
// 2026-10-26: the core lanes page as ONE key naming its lanes as subjects, so the bar
// reads which lanes from what the page named rather than from a key per lane.
{
  const e = healthy();
  for (const s of e.samples) {
    if (s.atMs < T0 + 3 * MIN) continue;
    s.alerts[CORE_LANES_ALERT_KEY] = iso(T0 + 3 * MIN);
    s.alertState = { [CORE_LANES_ALERT_KEY]: { subjects: ["outbox", "monitor"], band: null } };
  }
  const found = findingsOf(e);
  assert(found.some((d) => d.includes("watchdog paged that the outbox lane")), "the combined page's lanes are each a finding");
  assert(!found.some((d) => d.includes("monitor lane")), "but not a lane this deployment does not run");
  const u = healthy();
  for (const s of u.samples) if (s.atMs >= T0 + 3 * MIN) s.alerts[CORE_LANES_ALERT_KEY] = iso(T0 + 3 * MIN);
  assert(
    findingsOf(u).some((d) => d.includes("which lanes it named was not read")),
    "a combined page whose lanes were not read is still a finding, never excused (L98)",
  );
}

// --- the platform stopped firing the crons (#3746) --------------------------------
// Run 38635866855: every one minute lane went stale together for about fourteen
// minutes, and Workers Logs held no scheduled invocation of the Worker at all while
// it served thousands of requests. Cloudflare had an open cron trigger incident. The
// lanes did not fail; the crons never fired, and the judge blamed a dependency (L11).
// Told apart by the stamps of EVERY lane together: a dependency failing one call in
// ten cannot stop every lane in the same minutes, a platform that fires no cron can.
/** A twenty minute window where `frozen` lanes stop stamping from `from` to `to` minutes in. */
function series(frozen: readonly string[], from: number, to: number): FaultLaneEvidence {
  const samples: FaultLaneEvidence["samples"] = [];
  const lastBefore: Record<string, number> = {};
  for (let at = T0 - 30_000; at <= T0 + 20 * MIN; at += 15_000) {
    const lastMinute = at - (at % MIN);
    const lastFive = at - (at % (5 * MIN));
    // A frozen lane records no run inside the stretch, so a stamp it would have
    // written there is the last one it wrote before it.
    const stamp = (lane: string, ms: number) => {
      const inStretch = frozen.includes(lane) && ms >= T0 + from * MIN && ms < T0 + to * MIN;
      // The lane's last run before the stretch, on its own cadence, even when that run
      // came before the first reading (a stretch that began before the window).
      const cadence = lane === "complete" ? 5 * MIN : MIN;
      const priorRun = Math.floor((T0 + from * MIN - 1) / cadence) * cadence;
      if (inStretch) return iso(lastBefore[lane] ?? priorRun);
      if (ms < T0 + from * MIN) lastBefore[lane] = ms;
      return iso(ms);
    };
    samples.push({
      atMs: at,
      heartbeats: { sync: stamp("sync", lastMinute), outbox: stamp("outbox", lastMinute), complete: stamp("complete", lastFive - 5 * MIN) },
      alerts: at >= T0 + MIN ? { [SYNC_FAILURE_ALERT_KEY]: iso(T0 + MIN) } : {},
    });
  }
  return { kind: "fault-lanes", runId: "run-1", startedAtMs: T0 - 30_000, finishedAtMs: T0 + 20 * MIN, intervalMs: 15_000, samples, failedReads: 0 };
}
{
  eq(findingsOf(series([], 0, 0)), [], "control: the twenty minute series passes with nothing frozen");
  const f = findingsOf(series(["sync", "outbox", "complete"], 2, 16));
  // The last run before the freeze is the minute stamp at 1 min in, the next at 16 min.
  assert(f.some((d) => d.startsWith("no lane stamped a heartbeat for 15.0 min, every lane at once, from 1.0 min to 16.0 min")), `every lane stopping at once is named as no lane running, with its stretch (got ${JSON.stringify(f)})`);
  assert(f.some((d) => d.includes("the crons did not fire")), `and as the crons not firing (got ${JSON.stringify(f)})`);
  assert(!f.some((d) => d.includes("A failing dependency")), `and no lane is blamed on a dependency (got ${JSON.stringify(f)})`);
  assert(judgeFaultLanes(series(["sync", "outbox", "complete"], 2, 16), EXPECT).length > 0, "it still fails the run, since nothing about the lanes under fault was measured");
}
{
  // Control: one lane stopping while the others stamp is still that lane, blamed as before.
  const f = findingsOf(series(["outbox"], 2, 16));
  assert(f.some((d) => d.includes("outbox lane was stale") && d.includes("A failing dependency")), `a lane stopping alone is still blamed on a dependency (got ${JSON.stringify(f)})`);
  assert(!f.some((d) => d.includes("crons did not fire")), `and never on the platform (got ${JSON.stringify(f)})`);
}
{
  // A lane that stays stopped after the others come back stopped for its own reason
  // too, so the silence does not excuse it (and does still excuse the others).
  const e = series(["sync", "outbox", "complete"], 2, 16);
  const outboxFrozen = series(["outbox"], 2, 20);
  for (let i = 0; i < e.samples.length; i++) e.samples[i]!.heartbeats.outbox = outboxFrozen.samples[i]!.heartbeats.outbox!;
  const f = findingsOf(e);
  assert(f.some((d) => d.includes("crons did not fire")), `the shared stretch is still named (got ${JSON.stringify(f)})`);
  assert(f.some((d) => d.includes("outbox lane was stale") && d.includes("A failing dependency")), `the lane still stopped after it is blamed on its own cause (got ${JSON.stringify(f)})`);
  assert(f.some((d) => d.includes("sync lane was stale") && d.includes("crons not firing")), `while the lane that came back with the others is not (got ${JSON.stringify(f)})`);
}
{
  // A stretch that began BEFORE the faults did is said to have, so its length and its
  // range agree: lanes silent from four minutes before the window, for eighteen in all.
  const early = series(["sync", "outbox", "complete"], -4, 14);
  const f = findingsOf(early);
  const line = f.find((d) => d.startsWith("no lane stamped"));
  assert(line !== undefined && line.includes("for 19.0 min") && line.includes("from 5.0 min before the fault window began to 14.0 min into it"), `a stretch from before the window says so, and its range adds up to its length (got ${JSON.stringify(f)})`);
}
{
  // The lanes of one tick stamp one after another, so a lane resuming within a tick of the
  // first is still stale at the readings in between, and is the silence's, not a
  // dependency's. A lane still stopped minutes later is not (the case above).
  const e = series(["sync", "outbox", "complete"], 2, 16);
  const outboxLate = series(["outbox"], 2, 16.75);
  for (let i = 0; i < e.samples.length; i++) e.samples[i]!.heartbeats.outbox = outboxLate.samples[i]!.heartbeats.outbox!;
  const f = findingsOf(e);
  assert(f.some((d) => d.includes("outbox lane was stale") && d.includes("crons not firing")), `a lane resuming within a tick of the first is the silence's (got ${JSON.stringify(f)})`);
  assert(!f.some((d) => d.includes("A failing dependency") && d.includes("outbox")), `and is not blamed on a dependency (got ${JSON.stringify(f)})`);
}
{
  // Control: every lane pausing for less than the shortest bound is no finding at all.
  eq(findingsOf(series(["sync", "outbox", "complete"], 2, 6)), [], "a four minute pause of every lane, inside every bound, is not a finding");
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
  // The page requirement follows what the run was CONFIGURED to fail. Taking the
  // deployment's report instead would let a deployment that silently dropped calendar
  // reads drop the requirement that would have caught it (the mismatch itself is
  // incomplete in the run judge, tested in scripts/test-judge-booking-run.ts).
  const base = {
    rawDisabled: "monitor",
    bounds: { sync: 10 * MIN, monitor: 20 * MIN },
    knownLanes: ["sync", "monitor"],
    windowStartMs: T0,
  };
  const reads = faultLaneExpectationsFor({ ...base, configuredTargets: ["google-read", "supabase"] });
  eq("why" in reads ? null : reads.syncPageExpected, true, "configured to fail calendar reads, the page is required");
  const noReads = faultLaneExpectationsFor({ ...base, configuredTargets: ["supabase"] });
  eq("why" in noReads ? null : noReads.syncPageExpected, false, "and not when it was not");
  eq("why" in reads ? null : reads.lanes, { sync: 10 * MIN }, "held back lanes are left out");
  eq("why" in reads ? null : reads.mustRunInWindow, ["sync"], "and the every minute lanes must run");
  const blind = faultLaneExpectationsFor({ ...base, rawDisabled: undefined, configuredTargets: ["google-read"] });
  assert("why" in blind, "an unknown lane setting is a reason, not expectations");
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
    // #3248: the reroute hold expiry sweep runs every minute inside the self heal
    // lane and stamps its own heartbeat, so it is required to run too.
    ["outbox", "recompute", "reroute-hold-sweep", "selfheal", "sync"],
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
  assert(stale.includes(CORE_LANES_ALERT_KEY), `the watchdog really pages the core lanes on ${CORE_LANES_ALERT_KEY}`);

  // "Throttled" is judged as at most one send per CHANGE in a window (#3801): a repeat
  // naming nothing new is the throttle failing, which is only right while the page's
  // cooldown is longer than any window the sampler can produce.
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

// --- a change post is not a throttle failure (#3801) -----------------------------
//
// Dan's rule since #3801: an unchanged condition posts again once a day, and a CHANGE
// posts at once, where a change is a new subject or a worse band. At 200 advisors the
// sync lane reads calendars over more than one tick, so a second failing agent can
// cross its streak a minute after the first page: run 39074912498 posted with two
// agents, then with three (reason new-subject), and was failed for it. The sampler now
// records what each send named, so only a repeat with nothing new is the throttle failing.

/** Two sends a minute apart, with what each named. */
function twoSends(
  first: { subjects: string[] | null; band: number | null },
  second: { subjects: string[] | null; band: number | null },
): FaultLaneEvidence {
  const e = healthy();
  for (const sample of e.samples) {
    if (sample.atMs >= T0 + 2 * MIN) {
      sample.alerts[SYNC_FAILURE_ALERT_KEY] = iso(T0 + 2 * MIN);
      sample.alertState = { [SYNC_FAILURE_ALERT_KEY]: second };
    } else if (sample.atMs >= T0 + MIN) {
      sample.alerts[SYNC_FAILURE_ALERT_KEY] = iso(T0 + MIN);
      sample.alertState = { [SYNC_FAILURE_ALERT_KEY]: first };
    } else {
      delete sample.alerts[SYNC_FAILURE_ALERT_KEY];
    }
  }
  return e;
}
const throttled = (e: FaultLaneEvidence) => !findingsOf(e).some((d) => d.includes("not throttled"));
{
  assert(
    throttled(twoSends({ subjects: ["a", "b"], band: null }, { subjects: ["a", "b", "c"], band: null })),
    "a second page naming a new agent is the change post #3801 asks for, not a throttle failure",
  );
  assert(
    throttled(twoSends({ subjects: ["a", "b"], band: null }, { subjects: ["b", "c"], band: null })),
    "and so is one where a new agent replaced another",
  );
  assert(
    throttled(twoSends({ subjects: ["a"], band: 1 }, { subjects: ["a"], band: 2 }), ),
    "and one whose band got worse",
  );
  assert(
    !throttled(twoSends({ subjects: ["a", "b"], band: 1 }, { subjects: ["a", "b"], band: 1 })),
    "but the same page again is the throttle failing",
  );
  assert(
    !throttled(twoSends({ subjects: ["a", "b"], band: null }, { subjects: ["a"], band: null })),
    "and so is one where an agent only LEFT, which #3801 says is not a change",
  );
  assert(
    !throttled(twoSends({ subjects: ["a"], band: null }, { subjects: null, band: null })),
    "and a send whose subjects could not be read is counted as a repeat, never excused",
  );
}

finish();

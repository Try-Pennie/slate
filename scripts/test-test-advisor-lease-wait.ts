// #4180: the reroute drill and the smoke canary book on the same two smoke test advisors, and on
// 2026-10-23 at 15:34 UTC they overlapped and BOTH failed (the drill exit 16, the canary a 409).
// Now each side takes one server side lease on those advisors first, and polls for it up to a
// bound. This pins the CLIENT half of that, offline, on a fake clock (L290, L524):
//
//   - each side waits while the other holds the lease, and proceeds once it is released;
//   - past its bound each side reports NOT MEASURED, on its own exit, never a pass and never the
//     failure the collision used to cause;
//   - the bounds relate correctly to the lease's TTL and to each workflow's job timeout.
//
// The SERVER half (the lease itself: a crashed holder's claim expires, release is idempotent,
// the drill endpoint and the canary's lease endpoint exclude each other) is pinned in vitest by
// src/lib/booking/test-advisor-lease.test.ts.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-test-advisor-lease-wait.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANARY_LEASE_WAIT_MS,
  DRILL_LEASE_WAIT_MS,
  LEASE_POLL_INTERVAL_MS,
  waitForTestAdvisors,
} from "./lib/test-advisor-lease-wait.ts";
import {
  TEST_ADVISOR_LEASE_EXIT,
  readReleaseReply,
  readTakeReply,
  takeLeaseWhenFree,
} from "./lib/test-advisor-lease-client.ts";
import {
  REROUTE_DRILL_EXIT,
  RUN_JUDGEMENT,
  askDrillWhenAdvisorsFree,
  decideRerouteDrillReport,
  readDrillReply,
} from "./lib/reroute-drill-run-outcome.ts";
import { TEST_ADVISOR_LEASE_TTL_MS } from "../src/lib/booking/test-advisor-lease-terms.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const MIN = 60_000;

/** A clock that only moves when the code under test sleeps, so nothing here waits for real. */
function fakeClock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    slept,
    elapsed: () => t - 1_000_000,
  };
}

// --- the shared poller ---------------------------------------------------------------------
{
  // Waits while the other side holds, and proceeds once it is released.
  const clock = fakeClock();
  let calls = 0;
  const r = await waitForTestAdvisors(
    async () => {
      calls += 1;
      return calls < 4 ? { busy: true as const } : { busy: false as const, value: "mine" };
    },
    { now: clock.now, sleep: clock.sleep, boundMs: 5 * MIN },
  );
  eq(r.kind, "answered", "the poller proceeds once the other side releases");
  eq(calls, 4, "it asked once per interval while the lease was held, then once more");
  eq(clock.slept.length, 3, "it slept between the busy answers and never after the free one");
  assert(clock.slept.every((ms) => ms === LEASE_POLL_INTERVAL_MS), "each wait is one poll interval");
  if (r.kind === "answered") eq(r.value, "mine", "it hands back what the free attempt answered");
}
{
  // An answer that is not busy on the first try returns at once and never sleeps.
  const clock = fakeClock();
  const r = await waitForTestAdvisors(async () => ({ busy: false as const, value: 1 }), {
    now: clock.now,
    sleep: clock.sleep,
    boundMs: 5 * MIN,
  });
  eq(r.kind, "answered", "a free lease is taken on the first ask");
  eq(clock.slept.length, 0, "and nothing waited");
}
{
  // Past the bound: not measured, after a last ask AT the bound, never one past it.
  const clock = fakeClock();
  let calls = 0;
  const r = await waitForTestAdvisors(
    async () => {
      calls += 1;
      return { busy: true as const };
    },
    { now: clock.now, sleep: clock.sleep, boundMs: 50_000, intervalMs: 20_000 },
  );
  eq(r.kind, "not-measured", "a lease held past the bound is reported as not measured");
  eq(clock.elapsed(), 50_000, "having waited exactly the bound, not a poll interval past it");
  eq(clock.slept, [20_000, 20_000, 10_000], "the last sleep is cut to land on the bound");
  eq(calls, 4, "and the lease was asked for once more at the bound itself");
}
{
  // An ask that itself takes time counts against the bound (the drill's own request does).
  const clock = fakeClock();
  let calls = 0;
  const r = await waitForTestAdvisors(
    async () => {
      calls += 1;
      clock.advance(30_000);
      return { busy: true as const };
    },
    { now: clock.now, sleep: clock.sleep, boundMs: 60_000, intervalMs: 20_000 },
  );
  eq(r.kind, "not-measured", "slow asks still end at the bound");
  assert(calls <= 3, `and the time each ask took was counted (asked ${calls} times)`);
}

// --- the drill's side ----------------------------------------------------------------------
{
  // The endpoint answers the held lease as its own reason, which reads as its own exit.
  const held = readDrillReply(200, JSON.stringify({ reason: "test-advisors-held", detail: "x" }));
  eq(held.exit, REROUTE_DRILL_EXIT.testAdvisorsHeld, "the endpoint's held lease reads as its own exit");
  assert(held.exit !== REROUTE_DRILL_EXIT.didNotMove, "never as the did-not-move the collision used to cause");

  // Waits while the canary holds, then runs once it releases.
  const clock = fakeClock();
  const replies = [
    { exit: REROUTE_DRILL_EXIT.testAdvisorsHeld, detail: "held" },
    { exit: REROUTE_DRILL_EXIT.testAdvisorsHeld, detail: "held" },
    { exit: REROUTE_DRILL_EXIT.passed, detail: "all good" },
  ];
  let asked = 0;
  const done = await askDrillWhenAdvisorsFree(async () => replies[asked++]!, { now: clock.now, sleep: clock.sleep });
  eq(done, { exit: REROUTE_DRILL_EXIT.passed, detail: "all good" }, "the drill runs once the canary releases, and its verdict is the drill's own");
  eq(asked, 3, "having asked again while the lease was held");

  // Every other answer ends the wait at once: a refused key is not something waiting fixes.
  const clock2 = fakeClock();
  let asked2 = 0;
  const refused = await askDrillWhenAdvisorsFree(
    async () => {
      asked2 += 1;
      return { exit: REROUTE_DRILL_EXIT.unauthorized, detail: "no" };
    },
    { now: clock2.now, sleep: clock2.sleep },
  );
  eq(refused.exit, REROUTE_DRILL_EXIT.unauthorized, "a refused key ends the wait on its own exit");
  eq(asked2, 1, "after one ask");

  // Held past the bound: not measured, on its own exit, which stamps nothing.
  const clock3 = fakeClock();
  const blocked = await askDrillWhenAdvisorsFree(async () => ({ exit: REROUTE_DRILL_EXIT.testAdvisorsHeld, detail: "held" }), {
    now: clock3.now,
    sleep: clock3.sleep,
  });
  eq(blocked.exit, REROUTE_DRILL_EXIT.testAdvisorsHeld, "past its bound the drill reports the held lease, not a failure");
  eq(clock3.elapsed(), DRILL_LEASE_WAIT_MS, "after waiting its whole bound");
  assert(/not measured|did not start/i.test(blocked.detail), "and says the drill did not run");
  eq(RUN_JUDGEMENT[REROUTE_DRILL_EXIT.testAdvisorsHeld].concluded, false, "a held lease is not a measured verdict, so it never stamps");
  const report = decideRerouteDrillReport({ exit: REROUTE_DRILL_EXIT.testAdvisorsHeld, detail: blocked.detail }, "https://run/9");
  eq(report.concluded, false, "the reporter does not stamp it");
  // Dan, 2026-10-23: a drill the canary kept off the test advisors posts nothing.
  eq(report.alert, null, "and posts nothing, so a canary that held the advisors is never news");
}

// --- the canary's side ---------------------------------------------------------------------
{
  eq(readTakeReply(200, JSON.stringify({ outcome: "held", token: "2026-10-23T15:34:00.000Z" })), {
    exit: TEST_ADVISOR_LEASE_EXIT.ok,
    detail: "The smoke test advisors are held for this run.",
    token: "2026-10-23T15:34:00.000Z",
  }, "a taken lease hands back its token");
  eq(readTakeReply(200, JSON.stringify({ outcome: "busy" })).exit, TEST_ADVISOR_LEASE_EXIT.notMeasured, "a lease held elsewhere is the not measured exit");
  eq(readTakeReply(200, JSON.stringify({ outcome: "held" })).exit, TEST_ADVISOR_LEASE_EXIT.unreadableReply, "held with no token is unreadable, never a lease");
  eq(readTakeReply(401, "").exit, TEST_ADVISOR_LEASE_EXIT.unauthorized, "a refused key");
  eq(readTakeReply(503, "").exit, TEST_ADVISOR_LEASE_EXIT.notConfigured, "no canary key on the deployment");
  eq(readTakeReply(404, "").exit, TEST_ADVISOR_LEASE_EXIT.endpointMissing, "a deployment older than the endpoint");
  eq(readTakeReply(500, "x").exit, TEST_ADVISOR_LEASE_EXIT.unreadableReply, "any other status");
  eq(readTakeReply(200, "<html>").exit, TEST_ADVISOR_LEASE_EXIT.unreadableReply, "a body that is not the endpoint's");

  // Waits while the drill holds, then takes the lease once it is released.
  const clock = fakeClock();
  const answers = [
    { status: 200, body: JSON.stringify({ outcome: "busy" }) },
    { status: 200, body: JSON.stringify({ outcome: "busy" }) },
    { status: 200, body: JSON.stringify({ outcome: "held", token: "t1" }) },
  ];
  let asked = 0;
  const taken = await takeLeaseWhenFree(async () => answers[asked++]!, { now: clock.now, sleep: clock.sleep });
  eq(taken.exit, TEST_ADVISOR_LEASE_EXIT.ok, "the canary takes the lease once the drill releases it");
  eq(taken.token, "t1", "with the token the release will need");
  eq(asked, 3, "having asked again while the drill held it");

  // Held past the bound: not measured.
  const clock2 = fakeClock();
  const blocked = await takeLeaseWhenFree(async () => ({ status: 200, body: JSON.stringify({ outcome: "busy" }) }), {
    now: clock2.now,
    sleep: clock2.sleep,
  });
  eq(blocked.exit, TEST_ADVISOR_LEASE_EXIT.notMeasured, "past its bound the canary reports not measured");
  eq(blocked.token, undefined, "and holds nothing");
  eq(clock2.elapsed(), CANARY_LEASE_WAIT_MS, "after waiting its whole bound");

  // A network failure ends the wait as no answer, on its own exit.
  const clock3 = fakeClock();
  const silent = await takeLeaseWhenFree(async () => {
    throw new Error("connect timeout");
  }, { now: clock3.now, sleep: clock3.sleep });
  eq(silent.exit, TEST_ADVISOR_LEASE_EXIT.noAnswer, "a request that never answered is no answer");

  // Release: idempotent, and says which.
  eq(readReleaseReply(200, JSON.stringify({ outcome: "released" })).exit, TEST_ADVISOR_LEASE_EXIT.ok, "a release that freed the claim");
  eq(readReleaseReply(200, JSON.stringify({ outcome: "not-held" })).exit, TEST_ADVISOR_LEASE_EXIT.ok, "a second release is fine too (idempotent)");
  assert(/no longer held/i.test(readReleaseReply(200, JSON.stringify({ outcome: "not-held" })).detail), "and says the claim was already gone");
  eq(readReleaseReply(500, JSON.stringify({ outcome: "refused" })).exit, TEST_ADVISOR_LEASE_EXIT.releaseRefused, "a refused release has its own exit");

  const codes = Object.values(TEST_ADVISOR_LEASE_EXIT);
  eq(new Set(codes).size, codes.length, "every lease ending exits on its own code (L11)");
}

// --- the bounds, against the lease and the two jobs ------------------------------------------
{
  // The drill's 5 minute reply deadline is the longest the drill can hold the lease.
  const DRILL_REPLY_DEADLINE_MS = 5 * MIN;
  assert(TEST_ADVISOR_LEASE_TTL_MS > DRILL_REPLY_DEADLINE_MS, "the lease outlives a drill, so it never lapses under one still running");
  assert(
    DRILL_LEASE_WAIT_MS > TEST_ADVISOR_LEASE_TTL_MS,
    "the drill waits longer than the lease's TTL, so even a crashed canary's claim lapses inside its wait",
  );
  assert(
    CANARY_LEASE_WAIT_MS > DRILL_REPLY_DEADLINE_MS,
    "the canary waits longer than the longest drill, so a drill in flight never costs a full pass",
  );

  const minutes = (file: string): number => {
    const yml = readFileSync(join(ROOT, ".github", "workflows", file), "utf8");
    return Number(yml.match(/^ {4}timeout-minutes:\s*(\d+)/m)?.[1] ?? NaN);
  };
  // The burst counter's job runs two proofs before the drill (about 2 and 2.5 minutes at worst)
  // and the install; the drill then waits up to its bound and runs up to its deadline.
  const burst = minutes("burst-counter.yml");
  assert(
    burst * MIN >= 2 * MIN + 5 * MIN + DRILL_LEASE_WAIT_MS + DRILL_REPLY_DEADLINE_MS,
    `the burst counter job (${burst} min) holds the install, the proofs before the drill, the drill's wait and the drill`,
  );
  // The canary's job: install, the wait, the full pass (measured max 139s for the whole job),
  // the latency check with its recheck, and the embed check.
  const canary = minutes("smoke-canary.yml");
  assert(
    canary * MIN >= CANARY_LEASE_WAIT_MS + 10 * MIN,
    `the canary job (${canary} min) holds the wait with ten minutes left for everything else`,
  );
}

finish();

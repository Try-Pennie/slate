// Behavior lock for triggerCanaryGapFill (#525 follow-up): the smoke canary is a
// scheduled GitHub Actions workflow, but GitHub drops scheduled runs under load
// (observed 2-3h gaps against a */30 cadence), so the heartbeat ages past the 90m
// bound and the lane-watchdog pages even though the booking path is healthy. This
// makes the reliable Worker monitor lane a GAP-FILLER: only when the canary
// heartbeat has aged past the trigger threshold (GitHub missed a run) does it fire
// the workflow via GitHub's API. When GitHub's own schedule is behaving, the
// heartbeat is fresh and this is a no-op, so it is self-throttling.
//
// Guardrails proven here:
//   - a fresh heartbeat never dispatches (self-throttle),
//   - a never-stamped canary never dispatches (bootstrap is GitHub's schedule),
//   - no token configured is a quiet no-op (safe to deploy before the secret),
//   - the dispatch lock (a NOT-released cooldown lock) prevents a double-fire when
//     the lane runs twice or two invocations overlap ("assume it runs twice"),
//   - a GitHub API non-2xx or a thrown fetch is reported (fail loud) and NEVER
//     reported as a successful dispatch, and NEVER throws out of the lane.
//
// Driven through hand-written fakes, no DB / cron / network. Run:
//   node --experimental-strip-types scripts/test-canary-trigger.ts
import {
  triggerCanaryGapFill,
  CANARY_TRIGGER_STALE_MS,
  type CanaryTriggerDeps,
} from "@/lib/monitor/canary-trigger";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = 1_800_000_000_000;
const FRESH_AGE = 30 * 60_000; // < 40m threshold
const STALE_AGE = 45 * 60_000; // > 40m threshold

/** A deps object with sensible happy-path defaults; override per case. */
function deps(over: Partial<CanaryTriggerDeps> = {}): {
  d: CanaryTriggerDeps;
  calls: { dispatched: number; lockTried: number; infos: string[]; errors: string[] };
} {
  const calls = { dispatched: 0, lockTried: 0, infos: [] as string[], errors: [] as string[] };
  const d: CanaryTriggerDeps = {
    now: NOW,
    token: "ghp_faketoken",
    readHeartbeatMs: async () => NOW - STALE_AGE,
    acquireDispatchLock: async () => {
      calls.lockTried++;
      return true;
    },
    dispatch: async () => {
      calls.dispatched++;
      return { ok: true, status: 204 };
    },
    onInfo: (m) => calls.infos.push(m),
    onError: (m) => calls.errors.push(m),
    ...over,
  };
  return { d, calls };
}

async function main() {
  // sanity: the threshold is the documented 40 minutes.
  eq(CANARY_TRIGGER_STALE_MS, 40 * 60_000, "trigger threshold is 40m");

  // 1. Fresh heartbeat (GitHub's schedule is working): NEVER dispatch, never even
  //    reach for the lock.
  {
    const { d, calls } = deps({ readHeartbeatMs: async () => NOW - FRESH_AGE });
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, false, "fresh heartbeat does not dispatch");
    eq(r.reason, "fresh", "fresh heartbeat reason");
    eq(calls.dispatched, 0, "fresh: dispatch not called");
    eq(calls.lockTried, 0, "fresh: lock not attempted");
  }

  // 2. Never-stamped canary (null heartbeat): do NOT dispatch. Bootstrapping the
  //    first stamp is GitHub's own schedule; alerting/triggering on null would
  //    also fire forever when the canary is not yet configured.
  {
    const { d, calls } = deps({ readHeartbeatMs: async () => null });
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, false, "never-stamped does not dispatch");
    eq(r.reason, "never-stamped", "never-stamped reason");
    eq(calls.dispatched, 0, "never-stamped: dispatch not called");
  }

  // 3. Stale heartbeat, no token configured: quiet no-op (safe to deploy before
  //    the secret exists), but log an actionable info line so it is visible.
  {
    const { d, calls } = deps({ token: "" });
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, false, "no token does not dispatch");
    eq(r.reason, "no-token", "no-token reason");
    eq(calls.dispatched, 0, "no-token: dispatch not called");
    eq(calls.lockTried, 0, "no-token: lock not attempted");
    assert(calls.infos.length === 1, "no-token: emits one actionable info line");
  }

  // 4. Stale + token + lock won + dispatch ok: fires exactly once.
  {
    const { d, calls } = deps();
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, true, "stale+lock+ok dispatches");
    eq(r.reason, "dispatched", "dispatched reason");
    eq(calls.dispatched, 1, "dispatch called exactly once");
    eq(calls.lockTried, 1, "lock attempted once");
  }

  // 5. IDEMPOTENCY ("assume it runs twice"): stale + token but the cooldown/
  //    concurrency lock is held (a recent dispatch, or a concurrent invocation),
  //    so we must NOT double-fire the workflow.
  {
    const { d, calls } = deps({ acquireDispatchLock: async () => false });
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, false, "lock held does not dispatch");
    eq(r.reason, "cooldown", "cooldown reason");
    eq(calls.dispatched, 0, "cooldown: dispatch not called");
  }

  // 6. FAILURE PATH: GitHub API returns a non-2xx (bad/expired token, GitHub
  //    outage). Report the failure (fail loud), NEVER claim a successful dispatch,
  //    and NEVER throw out of the lane.
  {
    const { d, calls } = deps({ dispatch: async () => ({ ok: false, status: 401 }) });
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, false, "non-2xx is not a successful dispatch");
    eq(r.reason, "dispatch-failed", "dispatch-failed reason");
    assert(calls.errors.length === 1, "non-2xx: emits one error line (fail loud)");
    assert(
      calls.errors[0].includes("401"),
      `error line names the status (got ${JSON.stringify(calls.errors[0])})`,
    );
  }

  // 7. FAILURE PATH: the fetch itself throws (network error). Caught, reported,
  //    no throw, not a success.
  {
    let threw = false;
    const { d, calls } = deps({
      dispatch: async () => {
        throw new Error("network down");
      },
    });
    let r;
    try {
      r = await triggerCanaryGapFill(d);
    } catch {
      threw = true;
    }
    assert(!threw, "a thrown dispatch does not escape the lane");
    eq(r?.dispatched, false, "thrown dispatch is not a success");
    eq(r?.reason, "dispatch-error", "dispatch-error reason");
    assert(calls.errors.length === 1, "thrown dispatch: emits one error line (fail loud)");
  }

  // 8. A heartbeat exactly at the threshold is NOT stale (strict >), so no fire.
  {
    const { d, calls } = deps({ readHeartbeatMs: async () => NOW - CANARY_TRIGGER_STALE_MS });
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, false, "exactly-at-threshold does not dispatch");
    eq(calls.dispatched, 0, "boundary: dispatch not called");
  }

  finish();
}

void main();

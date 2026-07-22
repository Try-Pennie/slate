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
  runCanaryGapFills,
  postCanaryWorkflowDispatch,
  CANARY_TRIGGER_STALE_MS,
  CANARY_FULL_TRIGGER_STALE_MS,
  CANARY_DISPATCH_COOLDOWN_MS,
  CANARY_FULL_DISPATCH_COOLDOWN_MS,
  type CanaryGapFillWiring,
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

  // --- FULL-pass parity (#982). The same orchestration serves the 6h full pass
  // via an injected `staleMs` (its own, much longer threshold) so all the
  // guardrails above are reused with zero duplication. The full pass creates real
  // bookings, so it must NOT double-fire while a merely-late 6h run catches up. ---

  // 9. The full-pass trigger threshold is the documented 6h30m (6h cadence + a
  //    30m grace so a late-but-not-dropped scheduled run is not double-fired).
  eq(CANARY_FULL_TRIGGER_STALE_MS, 390 * 60_000, "full-pass trigger threshold is 6h30m");
  assert(
    CANARY_FULL_TRIGGER_STALE_MS > CANARY_TRIGGER_STALE_MS,
    "the full-pass threshold is far longer than the dry-pass threshold (6h vs 30m cadence)",
  );

  // 10. staleMs override, FRESH: a full heartbeat 6h old is within the 6h30m
  //     threshold, so GitHub's 6h schedule is working and we do NOT dispatch.
  {
    const { d, calls } = deps({
      staleMs: CANARY_FULL_TRIGGER_STALE_MS,
      readHeartbeatMs: async () => NOW - 6 * 60 * 60_000,
    });
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, false, "full pass 6h old is fresh against the 6h30m threshold");
    eq(r.reason, "fresh", "full-pass fresh reason");
    eq(calls.dispatched, 0, "full fresh: dispatch not called");
  }

  // 11. staleMs override, STALE: a full heartbeat 7h old is past the 6h30m
  //     threshold (GitHub dropped the 6h run), so fill the gap with a full run.
  {
    const { d, calls } = deps({
      staleMs: CANARY_FULL_TRIGGER_STALE_MS,
      readHeartbeatMs: async () => NOW - 7 * 60 * 60_000,
    });
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, true, "full pass 7h old is stale and dispatches");
    eq(r.reason, "dispatched", "full-pass dispatched reason");
    eq(calls.dispatched, 1, "full stale: dispatch called once");
  }

  // 12. The default staleMs (deps.staleMs undefined) is still the 40m dry
  //     threshold, so the existing dry wiring is unchanged.
  {
    const { d } = deps({ readHeartbeatMs: async () => NOW - 35 * 60_000 });
    const r = await triggerCanaryGapFill(d);
    eq(r.reason, "fresh", "no staleMs override keeps the 40m dry threshold (35m is fresh)");
  }

  // 13. postCanaryWorkflowDispatch puts the requested pass into the dispatch body,
  //     so the gap-fill can trigger a FULL run, not only the dry one. Drives the
  //     real fetch glue against a fake global fetch.
  {
    const realFetch = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string, init: { body?: string }) => {
      bodies.push(String(init?.body ?? ""));
      return { ok: true, status: 204 } as Response;
    }) as typeof fetch;
    try {
      await postCanaryWorkflowDispatch("tok", "full");
      await postCanaryWorkflowDispatch("tok", "dry");
      await postCanaryWorkflowDispatch("tok"); // default
    } finally {
      globalThis.fetch = realFetch;
    }
    assert(/"mode":"full"/.test(bodies[0]), `full dispatch body carries mode=full (got ${bodies[0]})`);
    assert(/"mode":"dry"/.test(bodies[1]), `dry dispatch body carries mode=dry (got ${bodies[1]})`);
    assert(/"mode":"dry"/.test(bodies[2]), `default dispatch body is mode=dry (got ${bodies[2]})`);
  }

  // --- runCanaryGapFills wiring (#982): the two near-identical gap-fills are easy
  // to cross-wire (a swapped lane/lock silently disables one), so assert each is
  // wired to its OWN lane, lock, threshold, and pass. ---

  /** A wiring harness that records exactly which lane/lock/mode each side used. */
  function wiring(over: Partial<CanaryGapFillWiring> = {}): {
    w: CanaryGapFillWiring;
    calls: {
      lanesRead: string[];
      locks: [string, number][];
      modes: ("dry" | "full")[];
      errors: string[];
    };
  } {
    const calls = {
      lanesRead: [] as string[],
      locks: [] as [string, number][],
      modes: [] as ("dry" | "full")[],
      errors: [] as string[],
    };
    const w: CanaryGapFillWiring = {
      now: NOW,
      token: "ghp_faketoken",
      readHeartbeatMs: async (lane) => {
        calls.lanesRead.push(lane);
        return NOW - 8 * 60 * 60_000; // 8h: stale for BOTH thresholds
      },
      acquireLock: async (name, ttl) => {
        calls.locks.push([name, ttl]);
        return true;
      },
      dispatch: async (mode) => {
        calls.modes.push(mode);
        return { ok: true, status: 204 };
      },
      onError: (m) => calls.errors.push(m),
      ...over,
    };
    return { w, calls };
  }

  // 14. Both stale: each pass fires, wired to its OWN lane, lock+ttl, and mode.
  {
    const { w, calls } = wiring();
    const r = await runCanaryGapFills(w);
    eq(r.dry?.dispatched, true, "dry pass dispatches when stale");
    eq(r.full?.dispatched, true, "full pass dispatches when stale");
    eq(calls.lanesRead.join(","), "smoke-canary,smoke-canary-full", "reads the two distinct lanes in order");
    eq(
      JSON.stringify(calls.locks),
      JSON.stringify([
        ["canary_dispatch", CANARY_DISPATCH_COOLDOWN_MS],
        ["canary_dispatch_full", CANARY_FULL_DISPATCH_COOLDOWN_MS],
      ]),
      "each pass takes its OWN dispatch lock with its OWN cooldown ttl",
    );
    eq(calls.modes.join(","), "dry,full", "dispatches the dry pass then the full pass");
  }

  // 15. Threshold isolation: a heartbeat 60m old is stale for the 40m dry
  //     threshold but FRESH for the 6h30m full threshold, so ONLY the dry pass
  //     fires. This proves the full side is not using the dry threshold.
  {
    const { w, calls } = wiring({ readHeartbeatMs: async (lane) => (void lane, NOW - 60 * 60_000) });
    const r = await runCanaryGapFills(w);
    eq(r.dry?.dispatched, true, "60m old dry heartbeat is stale (40m threshold) and fires");
    eq(r.full?.reason, "fresh", "60m old full heartbeat is fresh (6h30m threshold) and does NOT fire");
    eq(calls.modes.join(","), "dry", "only the dry pass dispatched at 60m");
  }

  // 16. Isolation: a throw in the dry side (a heartbeat read error) is reported and
  //     returns null for that pass, but the full side STILL runs (one broken pass
  //     must not silence the other), and nothing throws out of the helper.
  {
    let threw = false;
    const { w, calls } = wiring({
      readHeartbeatMs: async (lane) => {
        if (lane === "smoke-canary") throw new Error("db down");
        return NOW - 8 * 60 * 60_000;
      },
    });
    let r;
    try {
      r = await runCanaryGapFills(w);
    } catch {
      threw = true;
    }
    assert(!threw, "a thrown gap-fill does not escape the helper");
    eq(r?.dry, null, "the failed dry pass returns null");
    eq(r?.full?.dispatched, true, "the full pass still runs after the dry pass threw");
    assert(calls.errors.length >= 1, "the thrown pass is reported (fail loud)");
  }

  finish();
}

void main();

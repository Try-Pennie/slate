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
  postWorkflowDispatch,
  countActiveWorkflowRuns,
  CANARY_TRIGGER_STALE_MS,
  CANARY_FULL_TRIGGER_STALE_MS,
  CANARY_DISPATCH_COOLDOWN_MS,
  CANARY_FULL_DISPATCH_COOLDOWN_MS,
  PARITY_TRIGGER_STALE_MS,
  PARITY_DISPATCH_COOLDOWN_MS,
  REPLAY_TRIGGER_STALE_MS,
  REPLAY_DISPATCH_COOLDOWN_MS,
  GAP_FILL_PASSES,
  type CanaryGapFillWiring,
  type CanaryTriggerDeps,
  type GapFillPass,
} from "@/lib/monitor/canary-trigger";
import { CANARY_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  parseWorkflowSchedules,
  parseWorkflowDispatchInputs,
  cronCadenceMs,
} from "./lib/scan-workflow-schedules.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

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

  // --- FULL-pass parity (#982). The same orchestration serves the hourly full
  // pass (#1493) via an injected `staleMs` (its own, longer threshold) so all the
  // guardrails above are reused with zero duplication. The full pass creates real
  // bookings, so it must NOT double-fire while a merely-late hourly run catches up. ---

  // 9. The full-pass trigger threshold is the hourly cadence + a 30m grace, so a
  //    late-but-not-dropped scheduled run is not double-fired (#1493: the cadence
  //    went from 6h to 1h, and the grace is the one the 6h30m threshold carried).
  {
    const wf = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "smoke-canary.yml"), "utf8");
    assert(/cron:\s*"0 \* \* \* \*"/.test(wf), "the full pass this threshold is derived from is the hourly cron");
  }
  eq(CANARY_FULL_TRIGGER_STALE_MS, (60 + 30) * 60_000, "full-pass trigger threshold is the hourly cadence plus 30m");
  assert(
    CANARY_FULL_TRIGGER_STALE_MS > CANARY_TRIGGER_STALE_MS,
    "the full-pass threshold is longer than the dry-pass threshold",
  );
  // The watchdog's page on a stale full pass is the BACKSTOP behind this gap
  // fill, so it must sit past one gap fill attempt, its cooldown and a whole
  // run at the job's timeout (15m), or it pages before the gap fill has had its
  // chance (the relation the old 8h bound held against 6h30m).
  assert(
    CANARY_STALE_BOUNDS_MS["smoke-canary-full"] >= CANARY_FULL_TRIGGER_STALE_MS + CANARY_FULL_DISPATCH_COOLDOWN_MS + 15 * 60_000,
    "the full pass staleness page sits behind a whole gap fill attempt",
  );
  assert(
    CANARY_STALE_BOUNDS_MS["smoke-canary-full"] <= 4 * 60 * 60_000,
    "and an hourly full pass that has stopped pages within four hours, not the old eight",
  );

  // 10. staleMs override, FRESH: a full heartbeat 80 minutes old is within the
  //     90m threshold, so GitHub's hourly schedule is working and we do NOT dispatch.
  {
    const { d, calls } = deps({
      staleMs: CANARY_FULL_TRIGGER_STALE_MS,
      readHeartbeatMs: async () => NOW - 80 * 60_000,
    });
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, false, "full pass 80m old is fresh against the 90m threshold");
    eq(r.reason, "fresh", "full-pass fresh reason");
    eq(calls.dispatched, 0, "full fresh: dispatch not called");
  }

  // 11. staleMs override, STALE: a full heartbeat 2h old is past the 90m
  //     threshold (GitHub dropped the hourly run), so fill the gap with a full run.
  {
    const { d, calls } = deps({
      staleMs: CANARY_FULL_TRIGGER_STALE_MS,
      readHeartbeatMs: async () => NOW - 2 * 60 * 60_000,
    });
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, true, "full pass 2h old is stale and dispatches");
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

  // 13. postCanaryWorkflowDispatch: pin the FULL GitHub API payload and LOCK it to
  //     the real workflow file (#983). The orchestration tests inject a fake
  //     dispatch, so without this the real URL, headers, and body are unverified: a
  //     rename of the workflow file, a changed API endpoint, or a dropped `mode`
  //     input option would silently break the Worker trigger, and the only symptom
  //     would be the same stale-heartbeat page the gap-filler exists to prevent.
  {
    const realFetch = globalThis.fetch;
    const captured: { url: string; init: { method?: string; headers?: HeadersInit; body?: string } }[] = [];
    globalThis.fetch = (async (url: string, init: { method?: string; headers?: HeadersInit; body?: string }) => {
      captured.push({ url: String(url), init: init ?? {} });
      return { ok: true, status: 204 } as Response;
    }) as typeof fetch;
    try {
      await postWorkflowDispatch("ghp_tok", "full");
      await postWorkflowDispatch("ghp_tok", "dry");
      await postWorkflowDispatch("ghp_tok"); // default pass
    } finally {
      globalThis.fetch = realFetch;
    }

    // Contract with the workflow file: the endpoint must target the REAL workflow
    // by basename, so renaming smoke-canary.yml (or moving the repo) breaks this.
    const wfName = "smoke-canary.yml";
    assert(
      existsSync(join(ROOT, ".github", "workflows", wfName)),
      "the workflow file the dispatch URL names actually exists",
    );
    eq(
      captured[0].url,
      `https://api.github.com/repos/Try-Pennie/slate/actions/workflows/${wfName}/dispatches`,
      "POSTs the workflow_dispatch endpoint for the real workflow file",
    );

    // Method + headers GitHub requires (a missing User-Agent is rejected outright).
    const h = new Headers(captured[0].init.headers);
    eq(captured[0].init.method, "POST", "uses POST");
    eq(h.get("authorization"), "Bearer ghp_tok", "sends the caller's token as a Bearer credential");
    assert((h.get("user-agent") ?? "").length > 0, "sends a User-Agent (GitHub rejects calls without one)");
    eq(h.get("x-github-api-version"), "2022-11-28", "pins the GitHub REST API version");
    assert(/vnd\.github/.test(h.get("accept") ?? ""), "asks for the GitHub JSON media type");

    // Body: ref main + the requested mode, and that mode MUST be one the workflow
    // actually accepts, so dropping `dry` or `full` from the YAML breaks this test.
    const wf = readFileSync(join(ROOT, ".github", "workflows", wfName), "utf8");
    const modeOptions = (wf.match(/options:\s*\[([^\]]+)\]/)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim());
    assert(
      modeOptions.includes("dry") && modeOptions.includes("full"),
      `the workflow's mode input still offers dry and full (got ${JSON.stringify(modeOptions)})`,
    );
    const body0 = JSON.parse(String(captured[0].init.body));
    eq(body0.ref, "main", "dispatches against the main branch");
    assert(modeOptions.includes(body0.inputs.mode), "the dispatched mode is a valid workflow input option");
    eq(body0.inputs.mode, "full", "the first call requested the full pass");
    eq(JSON.parse(String(captured[1].init.body)).inputs.mode, "dry", "the second call requested the dry pass");
    eq(JSON.parse(String(captured[2].init.body)).inputs.mode, "dry", "the default pass is dry");
  }

  // --- runCanaryGapFills wiring (#982): the two near-identical gap-fills are easy
  // to cross-wire (a swapped lane/lock silently disables one), so assert each is
  // wired to its OWN lane, lock, threshold, and pass. ---

  /** A wiring harness that records exactly which lane/lock/mode each side used. */
  function wiring(
    over: Partial<CanaryGapFillWiring> = {},
    // Seams that need to see what has already been recorded (a lock that is held
    // on the SECOND tick, a dispatch that is refused for one pass only). They are
    // parameters rather than `over` entries so the recording stays in one place: a
    // replaced `acquireLock` that forgot to record would make the wiring
    // assertions pass by never observing anything (L98).
    seams: {
      lockAllows?: (name: string, taken: [string, number][]) => boolean;
      dispatchResult?: (pass: GapFillPass) => { ok: boolean; status: number };
    } = {},
  ): {
    w: CanaryGapFillWiring;
    calls: {
      lanesRead: string[];
      locks: [string, number][];
      modes: GapFillPass[];
      errors: string[];
    };
  } {
    const calls = {
      lanesRead: [] as string[],
      locks: [] as [string, number][],
      modes: [] as GapFillPass[],
      errors: [] as string[],
    };
    const w: CanaryGapFillWiring = {
      now: NOW,
      token: "ghp_faketoken",
      readHeartbeatMs: async (lane) => {
        calls.lanesRead.push(lane);
        return NOW - 8 * 60 * 60_000; // 8h: stale for BOTH canary thresholds
      },
      acquireLock: async (name, ttl) => {
        const allowed = seams.lockAllows ? seams.lockAllows(name, calls.locks) : true;
        calls.locks.push([name, ttl]);
        return allowed;
      },
      dispatch: async (pass) => {
        calls.modes.push(pass);
        return seams.dispatchResult ? seams.dispatchResult(pass) : { ok: true, status: 204 };
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
    eq(
      calls.lanesRead.join(","),
      "smoke-canary,smoke-canary-full,schedule-parity,router-replay",
      "reads the four distinct lanes in order",
    );
    eq(
      JSON.stringify(calls.locks),
      JSON.stringify([
        ["canary_dispatch", CANARY_DISPATCH_COOLDOWN_MS],
        ["canary_dispatch_full", CANARY_FULL_DISPATCH_COOLDOWN_MS],
      ]),
      "each pass takes its OWN dispatch lock with its OWN cooldown ttl",
    );
    eq(calls.modes.join(","), "dry,full", "dispatches the dry pass then the full pass");
    // 8h is far inside the parity threshold (a DAILY sweep), so the third gap-fill
    // is read and correctly does nothing. That is the point of it being separate.
    eq(r.parity?.reason, "fresh", "an 8h old parity heartbeat is fresh on a daily cadence");
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

  // --- the DAILY cal.com parity sweep (#2414) ----------------------------------
  //
  // `schedule-parity.yml` had ONE scheduled attempt a day and no re-attempt at
  // all, so a run GitHub dropped cost the whole day: the sweep that watches Slate
  // and cal.com for drifting apart went blind until a person read a page thirty
  // hours later and dispatched it by hand. The manual re-run is not the remedy
  // (L533), so the gap filler that already re-fires the canary now re-fires this
  // too, on its own lane, its own lock and its own threshold.
  //
  // What makes this one different from its two siblings is the CADENCE. The canary
  // fires every 30 minutes, so a heartbeat older than 40 minutes is a dropped run.
  // This one fires once a day, so a heartbeat that is 23 hours old is a perfectly
  // healthy one, and a threshold borrowed from either sibling would dispatch a
  // second sweep every single morning against a sweep that had already succeeded.

  const PARITY_WORKFLOW = "schedule-parity.yml";
  const parityYml = readFileSync(join(ROOT, ".github", "workflows", PARITY_WORKFLOW), "utf8");

  // 17. The scanner's own positive control. Every derivation below is built on it,
  //     and a parser that read NOTHING hands back the same empty answer a workflow
  //     with no schedule would (L98), so prove it reads the real files first.
  {
    const crons = parseWorkflowSchedules(parityYml);
    eq(crons.length, 1, "the parity workflow declares exactly one cron line");
    const canaryYml = readFileSync(join(ROOT, ".github", "workflows", "smoke-canary.yml"), "utf8");
    eq(
      parseWorkflowSchedules(canaryYml).length,
      2,
      "the canary workflow's two cron lines are both read (a one line parser would pass on the parity file alone)",
    );
    eq(cronCadenceMs("*/30 * * * *"), 30 * 60_000, "a minute step reads as its own cadence");
    eq(cronCadenceMs("0 */6 * * *"), 6 * 60 * 60_000, "an hour step reads as its own cadence");
    eq(cronCadenceMs("20 12 * * *"), 24 * 60 * 60_000, "a fixed daily time reads as 24h");
    eq(cronCadenceMs("20 13 * * 1"), 7 * 24 * 60 * 60_000, "a fixed weekday time reads as 7 days");
    eq(cronCadenceMs("not a cron"), null, "an unreadable expression is refused, never guessed at");
    eq(cronCadenceMs("0 0 1 * *"), null, "a calendar dependent gap is refused rather than flattened");
  }

  // 18. THE THRESHOLD IS DERIVED FROM THE FILE, not from a number typed beside it
  //     (L614). The producing schedule is the workflow's own cron and the run's own
  //     timeout; the consuming schedule is the monitor lane. A threshold at or below
  //     the cadence fires a redundant sweep on a heartbeat that is doing exactly
  //     what it should, which is the waste this is supposed to avoid.
  const parityCadenceMs = cronCadenceMs(parseWorkflowSchedules(parityYml)[0] as string);
  const parityTimeoutMin = Number(parityYml.match(/^ {4}timeout-minutes:\s*(\d+)/m)?.[1] ?? NaN);
  {
    assert(parityCadenceMs !== null, "the parity cron is one this can read a cadence from");
    assert(Number.isFinite(parityTimeoutMin), "the parity job declares a timeout the derivation can use");
    // GitHub's scheduler runs LATE as well as dropping runs, and this repo measured
    // that lateness at 2 to 3 hours (the canary-trigger header). A threshold inside
    // that window re-fires a sweep that is merely late, so the grace has to clear it.
    const OBSERVED_GITHUB_LATENESS_MS = 3 * 60 * 60_000;
    const earliestHonest = (parityCadenceMs as number) + OBSERVED_GITHUB_LATENESS_MS + parityTimeoutMin * 60_000;
    assert(
      PARITY_TRIGGER_STALE_MS > (parityCadenceMs as number),
      `the threshold is longer than the sweep's own cadence, or it fires every day on a healthy heartbeat ` +
        `(threshold ${PARITY_TRIGGER_STALE_MS}ms, cadence ${parityCadenceMs}ms)`,
    );
    assert(
      PARITY_TRIGGER_STALE_MS >= earliestHonest,
      `the threshold clears the cadence plus GitHub's measured lateness plus the job's own timeout ` +
        `(threshold ${PARITY_TRIGGER_STALE_MS}ms, earliest honest ${earliestHonest}ms)`,
    );
    // And it must still leave the 30h page as the BACKSTOP rather than the remedy:
    // one dispatch, one cooldown, one failed retry and one full run all have to fit
    // inside the bound, or the page arrives while the re-attempt is still working.
    const bound = CANARY_STALE_BOUNDS_MS["schedule-parity"] as number;
    const worstRecovery =
      PARITY_TRIGGER_STALE_MS + PARITY_DISPATCH_COOLDOWN_MS + parityTimeoutMin * 60_000;
    assert(
      worstRecovery < bound,
      `a dispatch, one cooldown retry and a full run fit inside the staleness bound, so the page is the ` +
        `backstop (worst recovery ${worstRecovery}ms, bound ${bound}ms)`,
    );
  }

  // 19. A FRESH parity heartbeat fires nothing, and never reaches for the lock. A
  //     re-attempt on a sweep that already succeeded is pure waste, and it has to be
  //     decided by the REAL heartbeat rather than by anything standing in for it.
  {
    const { d, calls } = deps({
      staleMs: PARITY_TRIGGER_STALE_MS,
      readHeartbeatMs: async () => NOW - 23 * 60 * 60_000,
    });
    const r = await triggerCanaryGapFill(d);
    eq(r.reason, "fresh", "a 23h old daily heartbeat is fresh and dispatches nothing");
    eq(calls.dispatched, 0, "parity fresh: dispatch not called");
    eq(calls.lockTried, 0, "parity fresh: lock not attempted");
  }

  // 20. A STALE parity heartbeat fires EXACTLY ONE re-attempt, and the second tick
  //     five minutes later fires none: the lock is taken and not released, so the
  //     cooldown is also the concurrency guard ("assume it runs twice").
  {
    const { w, calls } = wiring(
      { readHeartbeatMs: async () => NOW - 28 * 60 * 60_000 },
      {
        // A NOT-released lock: once the parity key has been taken, a later tick
        // asking for it is refused until its TTL expires.
        lockAllows: (name, taken) =>
          name !== "parity_dispatch" || !taken.some(([n]) => n === "parity_dispatch"),
      },
    );
    const first = await runCanaryGapFills(w);
    eq(first.parity?.dispatched, true, "a 28h old parity heartbeat dispatches");
    eq(calls.modes.filter((m) => m === "parity").length, 1, "exactly one parity dispatch");
    assert(
      calls.locks.some(([n, t]) => n === "parity_dispatch" && t === PARITY_DISPATCH_COOLDOWN_MS),
      "the parity pass takes its OWN lock with its OWN cooldown ttl",
    );

    const second = await runCanaryGapFills(w);
    eq(second.parity?.dispatched, false, "the next tick does not re-fire while the lock is held");
    eq(second.parity?.reason, "cooldown", "the held lock is reported as a cooldown, not a success");
    eq(calls.modes.filter((m) => m === "parity").length, 1, "still exactly one parity dispatch after two ticks");
  }

  // 21. FAILURE PATH. A dispatch GitHub refuses is reported, is never counted as a
  //     re-attempt that happened, and does not escape the lane. The lock is
  //     deliberately NOT released on failure: it is the cooldown, so the next
  //     attempt is one cooldown away rather than on the very next tick, and it
  //     expires by its own TTL rather than being held for ever.
  {
    let threw = false;
    const { w, calls } = wiring(
      { readHeartbeatMs: async (lane) => (lane === "schedule-parity" ? NOW - 28 * 60 * 60_000 : NOW) },
      { dispatchResult: (pass) => (pass === "parity" ? { ok: false, status: 403 } : { ok: true, status: 204 }) },
    );
    let r;
    try {
      r = await runCanaryGapFills(w);
    } catch {
      threw = true;
    }
    assert(!threw, "a refused parity dispatch does not escape the lane");
    eq(r?.parity?.dispatched, false, "a refused dispatch is never reported as a re-attempt made");
    eq(r?.parity?.reason, "dispatch-failed", "the refusal has its own reason");
    assert(
      calls.errors.some((m) => m.includes("403")),
      `the refusal is reported and names the status (got ${JSON.stringify(calls.errors)})`,
    );
    assert(
      calls.locks.every(([, ttl]) => Number.isFinite(ttl) && ttl > 0),
      "every dispatch lock carries a finite TTL, so a failed attempt cannot hold it for ever",
    );
  }

  // 22. The parity pass targets the REAL parity workflow and sends NO inputs.
  //     `schedule-parity.yml` declares a `workflow_dispatch` with no inputs at all,
  //     and GitHub answers 422 to a dispatch carrying one it does not declare. That
  //     failure is invisible from inside the Worker (the run simply never happens),
  //     so the payload is checked against what the FILE declares rather than against
  //     what this code believes it declares.
  {
    const realFetch = globalThis.fetch;
    const captured: { url: string; body?: string }[] = [];
    globalThis.fetch = (async (url: string, init: { body?: string }) => {
      captured.push({ url: String(url), body: init?.body });
      return { ok: true, status: 204 } as Response;
    }) as typeof fetch;
    try {
      await postWorkflowDispatch("ghp_tok", "parity");
    } finally {
      globalThis.fetch = realFetch;
    }

    assert(
      existsSync(join(ROOT, ".github", "workflows", PARITY_WORKFLOW)),
      "the workflow file the parity dispatch URL names actually exists",
    );
    eq(
      captured[0]?.url,
      `https://api.github.com/repos/Try-Pennie/slate/actions/workflows/${PARITY_WORKFLOW}/dispatches`,
      "the parity pass POSTs the parity workflow, never the canary's",
    );

    const declared = parseWorkflowDispatchInputs(parityYml);
    assert(declared !== null, "the parity workflow can be dispatched at all (it declares workflow_dispatch)");
    eq((declared ?? []).length, 0, "the parity workflow declares no dispatch inputs");
    const body = JSON.parse(String(captured[0]?.body));
    eq(body.ref, "main", "the parity pass dispatches against the main branch");
    eq(
      Object.keys(body.inputs ?? {}).join(","),
      (declared ?? []).join(","),
      "the dispatch sends exactly the inputs the workflow declares, and GitHub 422s on any other",
    );
    // The reverse direction, so this cannot pass by sending nothing to everything:
    // the canary DOES declare an input, and the dry pass must still carry it.
    const canaryDeclared = parseWorkflowDispatchInputs(
      readFileSync(join(ROOT, ".github", "workflows", "smoke-canary.yml"), "utf8"),
    );
    eq((canaryDeclared ?? []).join(","), "mode", "the canary workflow still declares its mode input");
  }

  // 23. The table is the extension point (#2466 adds the weekly router replay as
  //     one entry). `Record<GapFillPass, ...>` makes tsc demand an entry for a new
  //     pass, but it cannot see a COPIED one: an entry that reuses a neighbour's
  //     lane or lock typechecks perfectly and silently gives two passes one
  //     heartbeat or one cooldown, so one of them stops being gap-filled while
  //     every surface still reads as correct. Only distinctness catches that.
  {
    const entries = Object.entries(GAP_FILL_PASSES);
    assert(entries.length >= 3, `the table holds every pass (got ${entries.length})`);
    const distinct = (name: string, values: string[]) =>
      eq(new Set(values).size, values.length, `every pass has its own ${name} (got ${values.join(",")})`);
    distinct("heartbeat lane", entries.map(([, c]) => c.lane));
    distinct("dispatch lock", entries.map(([, c]) => c.lock));
    for (const [pass, cfg] of entries) {
      assert(
        Number.isFinite(cfg.staleMs) && cfg.staleMs > 0,
        `${pass} carries a real staleness threshold`,
      );
      assert(
        Number.isFinite(cfg.cooldownMs) && cfg.cooldownMs > 0,
        `${pass} carries a real cooldown, so a failed dispatch cannot hold its lock for ever`,
      );
      assert(
        existsSync(join(ROOT, ".github", "workflows", cfg.workflow)),
        `${pass} names a workflow file that exists (${cfg.workflow})`,
      );
      // Each entry's inputs must match what ITS OWN file declares, so a fourth
      // entry copied from the canary inherits `mode` and is caught here rather
      // than by GitHub's 422 three weeks later.
      const declared =
        parseWorkflowDispatchInputs(readFileSync(join(ROOT, ".github", "workflows", cfg.workflow), "utf8")) ?? [];
      eq(
        Object.keys(cfg.inputs ?? {}).sort().join(","),
        declared.slice().sort().join(","),
        `${pass} sends exactly the inputs ${cfg.workflow} declares`,
      );
    }
  }

  // 24. The "cal.com retired" switch (#2875). Once cal.com takes no bookings the
  //     parity sweep compares against nothing, so re firing it daily is a workflow
  //     run spent proving cal.com is gone. Retired: the parity pass is not even
  //     read or locked, and the two booking canary passes run exactly as before.
  //     Live, and a setting that could not be read, keep today's behaviour.
  {
    const staleParity = async (lane: string) => (lane === "schedule-parity" ? NOW - 28 * 60 * 60_000 : NOW - 8 * 60 * 60_000);
    const retired = wiring({ calcomRetired: async () => true });
    // A recording reader with a stale parity heartbeat, so a pass that read it would fire.
    const lanesRead: string[] = [];
    retired.w.readHeartbeatMs = async (lane) => (lanesRead.push(lane), staleParity(lane));
    const r = await runCanaryGapFills(retired.w);
    eq(r.parity?.dispatched, false, "retired: the parity sweep is never re fired");
    eq(r.parity?.reason, "calcom-retired", "retired: it says why, rather than reading as fresh");
    assert(!lanesRead.includes("schedule-parity"), "retired: the parity heartbeat is not even read");
    assert(!retired.calls.locks.some(([n]) => n === "parity_dispatch"), "retired: the parity lock is not taken");
    eq(retired.calls.modes.join(","), "dry,full", "retired: the booking canary passes still fire");
    // #2466: the router replay is a cal.com lane too, so it stops on the same switch.
    eq(r.replay?.reason, "calcom-retired", "retired: the router replay is not re fired either");
    assert(!lanesRead.includes("router-replay"), "retired: the replay heartbeat is not even read");

    for (const [label, answer] of [["live", false], ["unreadable", null]] as const) {
      const { w, calls } = wiring({ calcomRetired: async () => answer });
      w.readHeartbeatMs = staleParity;
      const rr = await runCanaryGapFills(w);
      eq(rr.parity?.dispatched, true, `${label}: a 28h old parity heartbeat is re fired, as today`);
      assert(calls.modes.includes("parity"), `${label}: the parity dispatch is made`);
    }

    // A reader that throws is the same as one that could not read: today's behaviour.
    const { w: throwing, calls: throwingCalls } = wiring({
      calcomRetired: async () => {
        throw new Error("db down");
      },
    });
    throwing.readHeartbeatMs = staleParity;
    const rt = await runCanaryGapFills(throwing);
    eq(rt.parity?.dispatched, true, "a throwing retirement read keeps today's re fire");
    eq(throwingCalls.modes.join(","), "dry,full,parity", "and nothing else is skipped");
  }

  // --- the WEEKLY router replay (#2466) -----------------------------------------
  //
  // `router-replay.yml` has one scheduled attempt a WEEK, so a run GitHub dropped
  // cost the whole week, and the only remedy the page offered was a hand re run
  // (L533). It joins the table as a fourth pass, on its own lane, lock, cooldown and
  // threshold, every one of them derived from the workflow file below.
  const REPLAY_WORKFLOW = "router-replay.yml";
  const replayYml = readFileSync(join(ROOT, ".github", "workflows", REPLAY_WORKFLOW), "utf8");
  const replayCrons = parseWorkflowSchedules(replayYml);
  const replayCadenceMs = cronCadenceMs(replayCrons[0] as string);
  const replayTimeoutMin = Number(replayYml.match(/^ {4}timeout-minutes:\s*(\d+)/m)?.[1] ?? NaN);

  // 25. The threshold is derived from the file, exactly as the parity one is.
  {
    eq(replayCrons.length, 1, "the replay workflow declares exactly one cron line");
    eq(replayCadenceMs, 7 * 24 * 60 * 60_000, "and it is read as a weekly cadence");
    assert(Number.isFinite(replayTimeoutMin), "the replay job declares a timeout the derivation can use");
    const OBSERVED_GITHUB_LATENESS_MS = 3 * 60 * 60_000;
    const earliestHonest = (replayCadenceMs as number) + OBSERVED_GITHUB_LATENESS_MS + replayTimeoutMin * 60_000;
    assert(
      REPLAY_TRIGGER_STALE_MS >= earliestHonest,
      `the replay threshold clears the cadence plus GitHub's lateness plus the job's own timeout ` +
        `(threshold ${REPLAY_TRIGGER_STALE_MS}ms, earliest honest ${earliestHonest}ms)`,
    );
    // Not padded past need either: within an hour of the earliest honest moment, so
    // a dropped Monday run is re fired that same Monday rather than days later.
    assert(
      REPLAY_TRIGGER_STALE_MS - earliestHonest < 60 * 60_000,
      `the replay threshold is the derivation rounded up, not a guess (${REPLAY_TRIGGER_STALE_MS - earliestHonest}ms over)`,
    );
    // The 9 day page stays the BACKSTOP: a dispatch, one cooldown retry and a full
    // run all fit inside it, or the page arrives while the re fire is still working.
    const bound = CANARY_STALE_BOUNDS_MS["router-replay"] as number;
    const worstRecovery = REPLAY_TRIGGER_STALE_MS + REPLAY_DISPATCH_COOLDOWN_MS + replayTimeoutMin * 60_000;
    assert(
      worstRecovery < bound,
      `a replay dispatch, one cooldown retry and a full run fit inside the 9 day bound ` +
        `(worst ${worstRecovery}ms, bound ${bound}ms)`,
    );
    // And the cooldown is long enough that a run which starts and cannot conclude
    // (it posts to Slack each time) is not re fired more than once a day.
    assert(REPLAY_DISPATCH_COOLDOWN_MS >= 24 * 60 * 60_000, "a failing replay is re fired at most daily");
    eq(GAP_FILL_PASSES.replay.lane, "router-replay", "the replay pass judges the router-replay heartbeat");
    eq(GAP_FILL_PASSES.replay.workflow, REPLAY_WORKFLOW, "and dispatches the router replay workflow");
    eq(GAP_FILL_PASSES.replay.staleMs, REPLAY_TRIGGER_STALE_MS, "with its own threshold");
    eq(GAP_FILL_PASSES.replay.cooldownMs, REPLAY_DISPATCH_COOLDOWN_MS, "and its own cooldown");
  }

  // 26. A six day old replay heartbeat is a healthy weekly one: nothing fires, and
  //     the lock is never reached for. A threshold borrowed from the daily parity
  //     sweep would re fire a replay every day of the week.
  {
    const { w, calls } = wiring({
      readHeartbeatMs: async (lane) => (lane === "router-replay" ? NOW - 6 * 24 * 60 * 60_000 : NOW),
    });
    const r = await runCanaryGapFills(w);
    eq(r.replay?.reason, "fresh", "a six day old replay heartbeat is fresh on a weekly cadence");
    assert(!calls.modes.includes("replay"), "and nothing is dispatched for it");
    assert(!calls.locks.some(([n]) => n === "replay_dispatch"), "and its lock is not taken");
  }

  // 27. A dropped Monday: the heartbeat is a week and five hours old. Exactly one
  //     re fire, on its own lock and ttl, and the next tick does not fire again.
  {
    const { w, calls } = wiring(
      { readHeartbeatMs: async (lane) => (lane === "router-replay" ? NOW - (7 * 24 + 5) * 60 * 60_000 : NOW) },
      // A NOT-released lock: once taken, a later tick cannot take it again.
      { lockAllows: (name, taken) => !taken.some(([n]) => n === name) },
    );
    const first = await runCanaryGapFills(w);
    eq(first.replay?.dispatched, true, "a week and five hours old replay heartbeat is re fired");
    eq(calls.modes.join(","), "replay", "only the replay is dispatched");
    assert(
      calls.locks.some(([n, t]) => n === "replay_dispatch" && t === REPLAY_DISPATCH_COOLDOWN_MS),
      "the replay takes its OWN lock with its OWN cooldown",
    );
    const second = await runCanaryGapFills(w);
    eq(second.replay?.reason, "cooldown", "the next tick holds off while the lock stands");
    eq(calls.modes.filter((m) => m === "replay").length, 1, "still exactly one replay dispatch");
  }

  // 28. A refused replay dispatch is never reported as a re fire made.
  {
    const { w } = wiring(
      { readHeartbeatMs: async (lane) => (lane === "router-replay" ? NOW - 8 * 24 * 60 * 60_000 : NOW) },
      { dispatchResult: (pass) => (pass === "replay" ? { ok: false, status: 422 } : { ok: true, status: 204 }) },
    );
    const r = await runCanaryGapFills(w);
    eq(r.replay?.dispatched, false, "a 422 is not a re fire");
    eq(r.replay?.reason, "dispatch-failed", "it has its own reason");
  }

  // 29. The replay targets the REAL replay workflow and sends exactly the inputs it
  //     declares, which is none: GitHub 422s on any other, invisibly.
  {
    const realFetch = globalThis.fetch;
    let url = "";
    let body: { ref?: string; inputs?: Record<string, string> } = {};
    globalThis.fetch = (async (u: string, init: { body: string }) => {
      url = String(u);
      body = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    try {
      await postWorkflowDispatch("ghp_tok", "replay");
    } finally {
      globalThis.fetch = realFetch;
    }
    eq(
      url,
      `https://api.github.com/repos/Try-Pennie/slate/actions/workflows/${REPLAY_WORKFLOW}/dispatches`,
      "the replay pass POSTs the router replay workflow",
    );
    const declared = parseWorkflowDispatchInputs(replayYml);
    assert(declared !== null, "the replay workflow can be dispatched at all");
    eq((declared ?? []).length, 0, "the replay workflow declares no dispatch inputs");
    eq(body.ref, "main", "it dispatches against main");
    eq(Object.keys(body.inputs ?? {}).join(","), "", "and sends no inputs");
  }

  // #4009 (L796): a stale heartbeat is not proof GitHub LOST the run. A run queued
  // behind the workflow's concurrency group or a runner backlog stamps nothing until it
  // finishes, and a dispatch then joins the same group, where GitHub cancels whichever
  // run was pending in favour of the newest (a dry dispatch evicting a pending FULL
  // booking pass, since both modes share `smoke-canary`). So the gap-fill asks the queue
  // first, and waits on a run that is already there.
  {
    const { d, calls } = deps({ activeRuns: async () => 1 });
    const r = await triggerCanaryGapFill(d);
    eq(r.dispatched, false, "a stale heartbeat with a run already queued or running does not dispatch");
    eq(r.reason, "already-pending", "and says it is waiting on that run");
    eq(calls.dispatched, 0, "already pending: dispatch not called");
    eq(calls.lockTried, 0, "already pending: the cooldown is not spent, so the next tick can still fill a real gap");
    assert(calls.infos.some((m) => m.includes("already")), "already pending: one info line, which pages nobody");
    eq(calls.errors.length, 0, "already pending is not an error");
  }
  {
    const { d, calls } = deps({ activeRuns: async () => 0 });
    const r = await triggerCanaryGapFill(d);
    eq(r.reason, "dispatched", "with nothing queued or running, a stale heartbeat is a lost run and is refilled");
    eq(calls.dispatched, 1, "nothing pending: dispatched once");
  }
  for (const [label, activeRuns] of [
    ["unreadable", async () => null],
    ["throwing", async () => {
      throw new Error("socket hang up");
    }],
  ] as const) {
    const { d, calls } = deps({ activeRuns });
    const r = await triggerCanaryGapFill(d);
    eq(r.reason, "dispatched", `a queue that cannot be asked (${label}) keeps today's refill rather than leaving the gap open`);
    eq(calls.errors.length, 1, `and says once that GitHub could not be asked (${label})`);
  }
  {
    const asked: GapFillPass[] = [];
    const { w, calls } = wiring({
      activeRuns: async (pass) => {
        asked.push(pass);
        return pass === "dry" ? 1 : 0;
      },
    });
    const r = await runCanaryGapFills(w);
    eq(r.dry?.reason, "already-pending", "the wiring asks the queue for each pass");
    eq(r.full?.dispatched, true, "and a pass with nothing pending still fills its gap");
    eq(asked.join(","), "dry,full", "only the passes whose heartbeat is stale are asked about");
    eq(calls.modes.join(","), "full", "only the full pass dispatched");
  }
  {
    const realFetch = globalThis.fetch;
    let url = "";
    let signalled = false;
    const answer = (status: number, body: unknown) => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        url = String(input);
        signalled = init?.signal instanceof AbortSignal;
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    };
    const run = (status: string) => ({ id: 1, status, head_sha: "abc", html_url: "https://github.com/x" });
    try {
      answer(200, { workflow_runs: [run("completed"), run("queued"), run("in_progress"), run("pending"), run("completed")] });
      eq(await countActiveWorkflowRuns("ghp_tok", "full"), 3, "every run not yet completed counts as pending");
      eq(
        url.split("?")[0],
        `https://api.github.com/repos/Try-Pennie/slate/actions/workflows/${GAP_FILL_PASSES.full.workflow}/runs`,
        "it lists the runs of the pass's own workflow",
      );
      assert(signalled, "the listing carries its own timeout, so a hung GitHub cannot stall the monitor lane");
      answer(200, { workflow_runs: [run("completed")] });
      eq(await countActiveWorkflowRuns("ghp_tok", "dry"), 0, "only completed runs: nothing pending");
      answer(403, { message: "Resource not accessible" });
      eq(await countActiveWorkflowRuns("ghp_tok", "dry"), null, "a refused listing is unknown, never zero");
      answer(200, { message: "not a listing" });
      eq(await countActiveWorkflowRuns("ghp_tok", "dry"), null, "an unreadable listing is unknown, never zero");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  finish();
}

void main();

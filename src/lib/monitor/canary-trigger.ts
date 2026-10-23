import { isCalcomLane } from "@/lib/calcom/retirement";

/**
 * Reliable trigger for the booking smoke canary (#525 follow-up).
 *
 * The canary is a scheduled GitHub Actions workflow (`.github/workflows/
 * smoke-canary.yml`, every 30 minutes). GitHub scheduled runs are best-effort and get
 * throttled or silently DROPPED under load: observed 2-3h gaps against a 30-min
 * cadence, so the `smoke-canary` heartbeat aged past its 90m bound and the
 * lane-watchdog paged even though every run that DID fire succeeded. The booking
 * path was healthy; only GitHub's scheduler was unreliable.
 *
 * The fix keeps GitHub's schedule as a backup and adds this GAP-FILLER on the
 * Worker's reliable monitor cron lane: only when the canary heartbeat has aged
 * past CANARY_TRIGGER_STALE_MS (GitHub missed a run) does it fire the workflow via
 * GitHub's API. When GitHub's schedule is behaving, the heartbeat is fresh and
 * this is a no-op, so it self-throttles and adds no extra Actions runs.
 *
 * Pure orchestration over injected deps (no DB / cron / network), so it is
 * unit-tested end to end. It NEVER throws (it runs inside a cron lane) and NEVER
 * reports a dispatch it did not actually make (fail loud, no false success).
 */

/** GitHub's cadence is 30m; step in only after a 10m grace so a merely-late (not
 *  dropped) scheduled run is not double-fired. Worst-case heartbeat age before
 *  recovery stays well under the 90m watchdog bound. */
export const CANARY_TRIGGER_STALE_MS = 40 * 60_000;

/** After a dispatch, hold off this long before firing again. Realised as a
 *  NOT-released DB lock (see the wiring), which also serialises concurrent
 *  invocations so the lane can safely run twice. */
export const CANARY_DISPATCH_COOLDOWN_MS = 15 * 60_000;

/** Full-pass parity (#982). The full book/reschedule/cancel pass stamps its
 *  OWN `smoke-canary-full` heartbeat, so a dropped full run no longer hides
 *  behind the 30m dry tick's stamp. GitHub's cadence for it is hourly (#1493,
 *  was 6h); step in only after a 30m grace so a merely-late (not dropped)
 *  scheduled run is not double-fired. This sits under the 3h watchdog backstop
 *  (CANARY_STALE_BOUNDS_MS["smoke-canary-full"]) by a whole attempt, so the
 *  gap-fill normally recovers the pass before the watchdog pages. */
export const CANARY_FULL_TRIGGER_STALE_MS = (60 + 30) * 60_000;

/** A full gap-fill fires a real booking pass, so hold off longer than the dry
 *  cooldown before re-firing. Realised as a NOT-released DB lock in the wiring. */
export const CANARY_FULL_DISPATCH_COOLDOWN_MS = 30 * 60_000;

/**
 * The DAILY cal.com parity sweep (#2414), the third workflow in this family and
 * the one whose cadence makes it least like the other two.
 *
 * `schedule-parity.yml` had one scheduled attempt a day and no re-attempt at all,
 * so a run GitHub dropped cost the whole day: the only thing watching Slate and
 * cal.com for drifting apart went blind until the 30h heartbeat bound paged and a
 * person dispatched it by hand. Drift ran at about four agents a day the last time
 * that happened, and a manual re-run is not a remedy (L533).
 *
 * 27h30m, and every part of it is derived rather than chosen:
 *
 *   24h    the sweep's own cadence, read off the workflow's cron. A threshold at
 *          or below this would dispatch a second sweep every single morning
 *          against one that had already succeeded.
 *   +3h    the worst GitHub scheduling LATENESS this repo has measured (the 2 to
 *          3 hour gaps in the header above). A run that is merely late must not be
 *          double fired: the parity lane WRITES, correcting drifted hours in
 *          cal.com's image before it sweeps.
 *   +25m   the job's own `timeout-minutes`, because the heartbeat is stamped at
 *          the END of the run rather than at its start.
 *
 * `scripts/test-canary-trigger.ts` re-derives all three FROM the workflow file, so
 * editing the cron or the timeout without revisiting this fails the build.
 */
export const PARITY_TRIGGER_STALE_MS = (27 * 60 + 30) * 60_000;

/**
 * One hour, which is the RETRY interval as much as the cooldown: the lock is not
 * released, so a dispatch GitHub refuses is re-attempted one of these later.
 *
 * It is bounded from above by the 30h `schedule-parity` staleness bound, which has
 * to stay the BACKSTOP rather than the remedy: a dispatch at 27h30m, one refused
 * attempt, one cooldown and one full 25 minute run all fit inside it with an hour
 * to spare. The test asserts that relation rather than the number.
 */
export const PARITY_DISPATCH_COOLDOWN_MS = 60 * 60_000;

/**
 * The WEEKLY router replay (#2466), the fourth workflow in this family and the one
 * a dropped run costs most: `router-replay.yml` has one scheduled attempt a week, so
 * a run GitHub dropped used to cost the whole week, and the only remedy offered was
 * a hand re run (L533).
 *
 * 7 days 4 hours, derived exactly as the parity threshold is:
 *
 *   7d     the replay's own cadence, read off the workflow's cron. At or below this
 *          it would dispatch a second replay against one that had succeeded.
 *   +3h    the worst GitHub scheduling LATENESS this repo has measured, so a run
 *          that is merely late is not double fired. Firing early would mostly cost
 *          cal.com reads, on a key the OOO dual write shares.
 *   +45m   the job's own `timeout-minutes`, because the heartbeat is stamped at the
 *          END of the run.
 *
 * That is 7d 3h45m, rounded up to the hour. `scripts/test-canary-trigger.ts`
 * re-derives all three from the workflow file and holds the rounding under an hour.
 */
export const REPLAY_TRIGGER_STALE_MS = (7 * 24 + 4) * 60 * 60_000;

/**
 * A DAY, longer than the parity sweep's hour, because of what a re fire that does
 * not conclude costs. The replay stamps its heartbeat only when it reaches a
 * verdict, and a run whose sample was too thin, or that cal.com refused, still
 * posts to Slack saying so. An hourly retry would repeat that post every hour; a
 * daily one says it once a day, and gives the accumulating booking cache a day's
 * more runs to judge from. A refused dispatch is retried a day later too, which a
 * weekly measurement can afford.
 *
 * Bounded from above by the 9 day `router-replay` staleness bound, which stays the
 * BACKSTOP: the threshold, one retry and one full 45 minute run fit inside it with
 * hours to spare. The test asserts that relation rather than the number.
 */
export const REPLAY_DISPATCH_COOLDOWN_MS = 24 * 60 * 60_000;

export interface CanaryTriggerDeps {
  /** Current time (ms). */
  now: number;
  /** How long the heartbeat may age before the gap-filler steps in. Defaults to
   *  CANARY_TRIGGER_STALE_MS (the 40m dry threshold); the full pass injects
   *  CANARY_FULL_TRIGGER_STALE_MS. Lets one orchestration serve both passes. */
  staleMs?: number;
  /** GITHUB_CANARY_TOKEN; "" means not configured yet (quiet no-op). */
  token: string;
  /** What the log lines call this pass. Defaults to the dry canary's workflow,
   *  which is the only correct answer when nothing says otherwise; the wiring
   *  below names each pass so a parity dispatch is never reported as a canary
   *  one (L11: a message may claim only what its check measured). */
  label?: string;
  /** Last `smoke-canary` heartbeat (ms), or null if it has never stamped. */
  readHeartbeatMs: () => Promise<number | null>;
  /** Reserve the once-per-cooldown dispatch slot. true = we may fire now;
   *  false = a recent/concurrent dispatch holds it, so skip (idempotency). */
  acquireDispatchLock: () => Promise<boolean>;
  /** POST the workflow_dispatch to GitHub. Resolves the HTTP outcome. */
  dispatch: () => Promise<{ ok: boolean; status: number }>;
  /**
   * #4009 (L796): how many runs of this pass's workflow GitHub holds that have not
   * completed (queued, pending, waiting or in progress), or null when it could not be
   * asked. Asked only once the heartbeat is stale, before the cooldown is spent.
   * Omitted, every stale heartbeat reads as a lost run, as before.
   */
  activeRuns?: () => Promise<number | null>;
  /** Visible, non-paging info line (logs only). Optional. */
  onInfo?: (msg: string) => void;
  /** Surface a failure (fail loud). Optional. */
  onError?: (msg: string, err?: unknown) => void;
}

export interface CanaryTriggerResult {
  dispatched: boolean;
  reason:
    | "fresh"
    | "never-stamped"
    | "no-token"
    | "cooldown"
    /** #4009: a run of the workflow is already queued or running; it will stamp the heartbeat. */
    | "already-pending"
    | "dispatched"
    | "dispatch-failed"
    | "dispatch-error"
    /** #2875: this pass re fires a cal.com lane and cal.com is marked retired. */
    | "calcom-retired";
}

/** The repo the gap-filler triggers workflows in. */
const CANARY_REPO = "Try-Pennie/slate";

/** Which scheduled pass a gap-fill re-fires. */
export type GapFillPass = "dry" | "full" | "parity" | "replay";

/**
 * EVERYTHING that differs between one gap-fill and the next, in ONE table.
 *
 * The passes are near-identical wiring that is easy to get subtly wrong: a
 * swapped lane, lock or threshold silently leaves one pass ungap-filled while
 * every surface still looks correct. Keeping the differences here, rather than as
 * hand written call blocks, is why the fourth scheduled workflow (the weekly
 * router replay, #2466) was one entry in this table rather than another copy of
 * the wiring, and `Record<GapFillPass, ...>` makes `tsc` name the omission if
 * somebody widens the union and forgets the entry (L113).
 *
 * The `inputs` field is load bearing rather than tidiness. GitHub answers **422**
 * to a `workflow_dispatch` carrying an input the workflow does not declare, and
 * `schedule-parity.yml` declares none at all, so sending the canary's `mode` to it
 * would make every parity gap-fill fail. That failure is invisible from inside the
 * Worker: nothing runs, and the only symptom is the same stale heartbeat the
 * gap-fill exists to prevent. `scripts/test-canary-trigger.ts` reads the workflow
 * files and asserts each pass sends exactly the inputs its own file declares.
 *
 * Insertion order is the order the passes run in, and the tests assert it, so there
 * is no second list of pass names to drift out of step with this one (L41).
 */
export const GAP_FILL_PASSES: Record<
  GapFillPass,
  {
    /** The workflow file to dispatch, and the inputs it declares (null = none). */
    workflow: string;
    inputs: Record<string, string> | null;
    /** The heartbeat lane this pass stamps, and that judges whether it is due. */
    lane: string;
    /** The NOT-released cooldown lock, which is also the concurrency guard. */
    lock: string;
    cooldownMs: number;
    /** How stale that lane's heartbeat must be before stepping in. */
    staleMs: number;
  }
> = {
  dry: {
    workflow: "smoke-canary.yml",
    inputs: { mode: "dry" },
    lane: "smoke-canary",
    lock: "canary_dispatch",
    cooldownMs: CANARY_DISPATCH_COOLDOWN_MS,
    staleMs: CANARY_TRIGGER_STALE_MS,
  },
  full: {
    workflow: "smoke-canary.yml",
    inputs: { mode: "full" },
    lane: "smoke-canary-full",
    lock: "canary_dispatch_full",
    cooldownMs: CANARY_FULL_DISPATCH_COOLDOWN_MS,
    staleMs: CANARY_FULL_TRIGGER_STALE_MS,
  },
  // The parity sweep WRITES (it corrects drifted hours from cal.com before it
  // compares), so a re-attempt repeats that write. It is the same side effect the
  // dropped scheduled run would have had, the import is idempotent, and the
  // workflow's `concurrency: schedule-parity` group with `cancel-in-progress:
  // false` queues a dispatch behind a run already in flight rather than doubling
  // it. The 27h30m threshold is what keeps a merely late run from being re-fired.
  parity: {
    workflow: "schedule-parity.yml",
    inputs: null,
    lane: "schedule-parity",
    lock: "parity_dispatch",
    cooldownMs: PARITY_DISPATCH_COOLDOWN_MS,
    staleMs: PARITY_TRIGGER_STALE_MS,
  },
  // The weekly router replay (#2466). It reads cal.com and Slate and writes
  // nothing but its own heartbeat and a runner cache, so a re fire repeats no side
  // effect beyond the Slack post a run makes. Its `concurrency: router-replay`
  // group with `cancel-in-progress: false` queues a dispatch behind a run already
  // in flight rather than doubling it. A cal.com lane, so it stops being re fired
  // once cal.com is marked retired, as the workflow itself already stops running.
  replay: {
    workflow: "router-replay.yml",
    inputs: null,
    lane: "router-replay",
    lock: "replay_dispatch",
    cooldownMs: REPLAY_DISPATCH_COOLDOWN_MS,
    staleMs: REPLAY_TRIGGER_STALE_MS,
  },
};

/**
 * POST a `workflow_dispatch` to GitHub's REST API. Thin `fetch` glue used as the
 * `dispatch` dep in production; the orchestration above is tested with a fake in
 * its place. GitHub returns 204 on success. `fetch` works on the Cloudflare Worker
 * runtime (no node-only deps).
 */
export async function postWorkflowDispatch(
  token: string,
  pass: GapFillPass = "dry",
): Promise<{ ok: boolean; status: number }> {
  const target = GAP_FILL_PASSES[pass];
  const res = await fetch(
    `https://api.github.com/repos/${CANARY_REPO}/actions/workflows/${target.workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        // GitHub rejects API calls with no User-Agent.
        "user-agent": "slate-canary-gapfill",
      },
      body: JSON.stringify(
        target.inputs === null ? { ref: "main" } : { ref: "main", inputs: target.inputs },
      ),
    },
  );
  return { ok: res.ok, status: res.status };
}

/** How long the gap-fill waits for GitHub's run listing; the monitor lane must not stall on it. */
export const ACTIVE_RUNS_TIMEOUT_MS = 10_000;

/**
 * #4009: how many runs of a pass's workflow have not completed (queued, pending,
 * waiting, requested or in progress), from the newest 20, or null when GitHub refused
 * or answered something that is not a listing. Never zero for an answer it could not
 * read (L11). Both canary passes share `smoke-canary.yml` and its concurrency group, so
 * a run of either mode counts for both: a dispatch of one would cancel the other's
 * pending run. The newest 20 reach back ten hours at the canary's cadence, so an
 * unfinished run older than that is not seen; the watchdog's bound is far inside it.
 */
export async function countActiveWorkflowRuns(token: string, pass: GapFillPass): Promise<number | null> {
  const target = GAP_FILL_PASSES[pass];
  const res = await fetch(
    `https://api.github.com/repos/${CANARY_REPO}/actions/workflows/${target.workflow}/runs?per_page=20`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "slate-canary-gapfill",
      },
      signal: AbortSignal.timeout(ACTIVE_RUNS_TIMEOUT_MS),
    },
  );
  if (!res.ok) return null;
  const runs = ((await res.json().catch(() => null)) as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(runs)) return null;
  return runs.filter((r) => (r as { status?: unknown } | null)?.status !== "completed").length;
}

/** Everything every gap-fill shares, injected once. `dispatch` and `acquireLock`
 *  take the pass and the lock name, so the table below picks the right one. */
export interface CanaryGapFillWiring {
  now: number;
  token: string;
  /** Read a heartbeat lane's last-stamp (ms) or null. */
  readHeartbeatMs: (lane: string) => Promise<number | null>;
  /** Reserve a NOT-released cooldown lock by name+ttl; true = won it. */
  acquireLock: (name: string, ttlMs: number) => Promise<boolean>;
  /** POST a workflow_dispatch for the given pass. */
  dispatch: (pass: GapFillPass) => Promise<{ ok: boolean; status: number }>;
  /** #4009: runs of the pass's workflow not yet completed, or null when GitHub could not be asked. */
  activeRuns?: (pass: GapFillPass) => Promise<number | null>;
  onInfo?: (msg: string) => void;
  onError?: (msg: string, err?: unknown) => void;
  /**
   * #2875: whether cal.com is marked retired (`loadCalcomRetiredCached`). Asked
   * once per tick, and only matters to a pass whose lane is a cal.com lane
   * (`isCalcomLane`). Omitted, it reads as live, which is today's behaviour.
   */
  calcomRetired?: () => Promise<boolean | null>;
}

/**
 * Run EVERY gap-fill in `GAP_FILL_PASSES` with its own lane, lock, cooldown and
 * threshold (#982, #2414, #2466): the 30 minute dry canary tick, the hourly (#1493) full
 * booking pass, the daily cal.com parity sweep, and the weekly router replay.
 *
 * It is a loop over the table rather than one block per pass, so adding a
 * scheduled workflow is a table entry. Keeping it here (one tested place)
 * rather than inline in the cron lane is what makes the wiring assertable at all.
 *
 * Each pass is isolated: a throw in one (a heartbeat or lock read error) is
 * reported and leaves that pass null, so it can never skip the others. Never
 * throws.
 */
export async function runCanaryGapFills(
  w: CanaryGapFillWiring,
): Promise<Record<GapFillPass, CanaryTriggerResult | null>> {
  const results = {} as Record<GapFillPass, CanaryTriggerResult | null>;

  // #2875: once cal.com is retired, re firing a cal.com workflow spends a run
  // proving cal.com is gone. A read that failed, or threw, keeps today's re fire:
  // the cost of a wrong answer that way is one workflow run, and the cost of the
  // other is a live comparison going quiet with nothing re firing it.
  let calcomRetired: boolean | null = false;
  if (w.calcomRetired) {
    try {
      calcomRetired = await w.calcomRetired();
    } catch (err) {
      (w.onError ?? (() => {}))("canary gap-fill: the cal.com retired read threw; re firing as usual", err);
      calcomRetired = null;
    }
  }

  const askQueue = w.activeRuns;
  // Sequential, never `Promise.all`: these run on the invocation budget four cron
  // lanes share, and the tests assert the order the lanes are read in.
  for (const pass of Object.keys(GAP_FILL_PASSES) as GapFillPass[]) {
    const cfg = GAP_FILL_PASSES[pass];
    if (calcomRetired === true && isCalcomLane(cfg.lane)) {
      (w.onInfo ?? (() => {}))(`canary gap-fill: ${cfg.lane} is a cal.com lane and cal.com is retired, so it is not re fired`);
      results[pass] = { dispatched: false, reason: "calcom-retired" };
      continue;
    }
    try {
      results[pass] = await triggerCanaryGapFill({
        now: w.now,
        token: w.token,
        onInfo: w.onInfo,
        onError: w.onError,
        staleMs: cfg.staleMs,
        label: cfg.lane,
        readHeartbeatMs: () => w.readHeartbeatMs(cfg.lane),
        acquireDispatchLock: () => w.acquireLock(cfg.lock, cfg.cooldownMs),
        dispatch: () => w.dispatch(pass),
        activeRuns: askQueue ? () => askQueue(pass) : undefined,
      });
    } catch (err) {
      // Isolated per pass: a heartbeat or lock read that throws is reported and
      // leaves THIS pass null, so it can never skip the ones after it.
      (w.onError ?? (() => {}))(`canary gap-fill: wiring for ${cfg.lane} threw`, err);
      results[pass] = null;
    }
  }
  return results;
}

export async function triggerCanaryGapFill(
  deps: CanaryTriggerDeps,
): Promise<CanaryTriggerResult> {
  const { now, token, readHeartbeatMs, acquireDispatchLock, dispatch } = deps;
  const staleMs = deps.staleMs ?? CANARY_TRIGGER_STALE_MS;
  const label = deps.label ?? "smoke-canary";
  const info = deps.onInfo ?? (() => {});
  const error = deps.onError ?? (() => {});

  const heartbeatMs = await readHeartbeatMs();
  // Never stamped: leave the first stamp to GitHub's own schedule; triggering on
  // null would also fire forever when the canary is not configured.
  if (heartbeatMs === null) return { dispatched: false, reason: "never-stamped" };
  // GitHub's schedule is keeping the heartbeat fresh: nothing to do.
  if (now - heartbeatMs <= staleMs) return { dispatched: false, reason: "fresh" };

  // Stale: GitHub dropped a run. Fill the gap if we can.
  if (!token) {
    info(
      `canary gap-fill: the ${label} heartbeat is stale but GITHUB_CANARY_TOKEN is not set, so cannot trigger`,
    );
    return { dispatched: false, reason: "no-token" };
  }
  // #4009 (L796): stale is not proof the run was LOST. A run queued behind the
  // workflow's concurrency group or a runner backlog stamps nothing until it ends, and a
  // dispatch joins that same group, where GitHub cancels whichever run was pending in
  // favour of the newest. So ask first, before the cooldown is spent, and wait on a run
  // that is already there. A queue that cannot be asked keeps the refill: its cost is at
  // most a pending run replaced by the dispatch, which is what happened before; the
  // other way, a really dropped run would go unfilled until the watchdog pages.
  if (deps.activeRuns) {
    let active: number | null = null;
    try {
      active = await deps.activeRuns();
    } catch (err) {
      error(`canary gap-fill: could not ask GitHub whether a ${label} run is already pending; refilling as if none is`, err);
      active = -1;
    }
    if (active === null) {
      error(`canary gap-fill: GitHub's run listing for ${label} was unreadable; refilling as if no run is pending`);
    } else if (active > 0) {
      info(`canary gap-fill: the ${label} heartbeat is stale but ${active} run(s) of its workflow are already queued or running, so it waits on them rather than dispatching another`);
      return { dispatched: false, reason: "already-pending" };
    }
  }
  // The lock is both the cooldown and the concurrency guard: only the invocation
  // that wins it dispatches, and it is not released, so we do not re-fire until it
  // expires (the wiring sets the TTL to CANARY_DISPATCH_COOLDOWN_MS).
  if (!(await acquireDispatchLock())) return { dispatched: false, reason: "cooldown" };

  try {
    const res = await dispatch();
    if (!res.ok) {
      error(`canary gap-fill: GitHub dispatch for ${label} failed with status ${res.status}`);
      return { dispatched: false, reason: "dispatch-failed" };
    }
    info(`canary gap-fill: triggered ${label} because its heartbeat was stale`);
    return { dispatched: true, reason: "dispatched" };
  } catch (err) {
    error(`canary gap-fill: GitHub dispatch for ${label} threw`, err);
    return { dispatched: false, reason: "dispatch-error" };
  }
}

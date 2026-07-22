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

/** Full-pass parity (#982). The 6h full book/reschedule/cancel pass stamps its
 *  OWN `smoke-canary-full` heartbeat, so a dropped full run no longer hides
 *  behind the 30m dry tick's stamp. GitHub's cadence for it is 6h; step in only
 *  after a 30m grace so a merely-late (not dropped) scheduled run is not
 *  double-fired. This sits well under the 8h watchdog backstop
 *  (CANARY_STALE_BOUNDS_MS["smoke-canary-full"]), so the gap-fill normally
 *  recovers the pass before the watchdog pages. */
export const CANARY_FULL_TRIGGER_STALE_MS = 390 * 60_000;

/** A full gap-fill fires a real booking pass, so hold off longer than the dry
 *  cooldown before re-firing. Realised as a NOT-released DB lock in the wiring. */
export const CANARY_FULL_DISPATCH_COOLDOWN_MS = 30 * 60_000;

export interface CanaryTriggerDeps {
  /** Current time (ms). */
  now: number;
  /** How long the heartbeat may age before the gap-filler steps in. Defaults to
   *  CANARY_TRIGGER_STALE_MS (the 40m dry threshold); the full pass injects
   *  CANARY_FULL_TRIGGER_STALE_MS. Lets one orchestration serve both passes. */
  staleMs?: number;
  /** GITHUB_CANARY_TOKEN; "" means not configured yet (quiet no-op). */
  token: string;
  /** Last `smoke-canary` heartbeat (ms), or null if it has never stamped. */
  readHeartbeatMs: () => Promise<number | null>;
  /** Reserve the once-per-cooldown dispatch slot. true = we may fire now;
   *  false = a recent/concurrent dispatch holds it, so skip (idempotency). */
  acquireDispatchLock: () => Promise<boolean>;
  /** POST the workflow_dispatch to GitHub. Resolves the HTTP outcome. */
  dispatch: () => Promise<{ ok: boolean; status: number }>;
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
    | "dispatched"
    | "dispatch-failed"
    | "dispatch-error";
}

/** The repo and workflow the gap-filler triggers. */
const CANARY_REPO = "Try-Pennie/slate";
const CANARY_WORKFLOW_FILE = "smoke-canary.yml";

/**
 * POST a `workflow_dispatch` (dry pass) to GitHub's REST API. Thin `fetch` glue
 * used as the `dispatch` dep in production; the orchestration above is tested
 * with a fake in its place. GitHub returns 204 on success. `fetch` works on the
 * Cloudflare Worker runtime (no node-only deps).
 */
export async function postCanaryWorkflowDispatch(
  token: string,
  mode: "dry" | "full" = "dry",
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(
    `https://api.github.com/repos/${CANARY_REPO}/actions/workflows/${CANARY_WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        // GitHub rejects API calls with no User-Agent.
        "user-agent": "slate-canary-gapfill",
      },
      body: JSON.stringify({ ref: "main", inputs: { mode } }),
    },
  );
  return { ok: res.ok, status: res.status };
}

/** Everything the two gap-fills (dry + full) share, injected once. `dispatch` and
 *  `acquireLock` take the pass/lock so the wiring below picks the right one. */
export interface CanaryGapFillWiring {
  now: number;
  token: string;
  /** Read a heartbeat lane's last-stamp (ms) or null. */
  readHeartbeatMs: (lane: string) => Promise<number | null>;
  /** Reserve a NOT-released cooldown lock by name+ttl; true = won it. */
  acquireLock: (name: string, ttlMs: number) => Promise<boolean>;
  /** POST a workflow_dispatch for the given pass. */
  dispatch: (mode: "dry" | "full") => Promise<{ ok: boolean; status: number }>;
  onInfo?: (msg: string) => void;
  onError?: (msg: string, err?: unknown) => void;
}

/**
 * Run BOTH canary gap-fills with their correct lane, lock, threshold, and pass
 * (#982). The dry tick (`smoke-canary`, 40m threshold, `canary_dispatch` lock,
 * mode=dry) and the full pass (`smoke-canary-full`, 6h30m threshold,
 * `canary_dispatch_full` lock, mode=full) are near-identical wiring that is easy
 * to get subtly wrong: a swapped lane or lock would silently leave one pass
 * ungap-filled while looking correct. Keeping it here (one tested place) rather
 * than inline in the cron lane makes that wiring assertable.
 *
 * Each call is isolated: a throw in one (a heartbeat/lock read error) is reported
 * and returns null for that pass, so it can never skip the other. Never throws.
 */
export async function runCanaryGapFills(
  w: CanaryGapFillWiring,
): Promise<{ dry: CanaryTriggerResult | null; full: CanaryTriggerResult | null }> {
  const one = async (
    extra: Pick<CanaryTriggerDeps, "staleMs" | "readHeartbeatMs" | "acquireDispatchLock" | "dispatch">,
  ): Promise<CanaryTriggerResult | null> => {
    try {
      return await triggerCanaryGapFill({
        now: w.now,
        token: w.token,
        onInfo: w.onInfo,
        onError: w.onError,
        ...extra,
      });
    } catch (err) {
      (w.onError ?? (() => {}))("canary gap-fill: wiring threw", err);
      return null;
    }
  };

  const dry = await one({
    readHeartbeatMs: () => w.readHeartbeatMs("smoke-canary"),
    acquireDispatchLock: () => w.acquireLock("canary_dispatch", CANARY_DISPATCH_COOLDOWN_MS),
    dispatch: () => w.dispatch("dry"),
  });
  const full = await one({
    staleMs: CANARY_FULL_TRIGGER_STALE_MS,
    readHeartbeatMs: () => w.readHeartbeatMs("smoke-canary-full"),
    acquireDispatchLock: () => w.acquireLock("canary_dispatch_full", CANARY_FULL_DISPATCH_COOLDOWN_MS),
    dispatch: () => w.dispatch("full"),
  });
  return { dry, full };
}

export async function triggerCanaryGapFill(
  deps: CanaryTriggerDeps,
): Promise<CanaryTriggerResult> {
  const { now, token, readHeartbeatMs, acquireDispatchLock, dispatch } = deps;
  const staleMs = deps.staleMs ?? CANARY_TRIGGER_STALE_MS;
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
    info("canary gap-fill: heartbeat is stale but GITHUB_CANARY_TOKEN is not set, so cannot trigger");
    return { dispatched: false, reason: "no-token" };
  }
  // The lock is both the cooldown and the concurrency guard: only the invocation
  // that wins it dispatches, and it is not released, so we do not re-fire until it
  // expires (the wiring sets the TTL to CANARY_DISPATCH_COOLDOWN_MS).
  if (!(await acquireDispatchLock())) return { dispatched: false, reason: "cooldown" };

  try {
    const res = await dispatch();
    if (!res.ok) {
      error(`canary gap-fill: GitHub dispatch failed with status ${res.status}`);
      return { dispatched: false, reason: "dispatch-failed" };
    }
    info("canary gap-fill: triggered smoke-canary because its heartbeat was stale");
    return { dispatched: true, reason: "dispatched" };
  } catch (err) {
    error("canary gap-fill: GitHub dispatch threw", err);
    return { dispatched: false, reason: "dispatch-error" };
  }
}

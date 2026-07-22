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

export interface CanaryTriggerDeps {
  /** Current time (ms). */
  now: number;
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
      body: JSON.stringify({ ref: "main", inputs: { mode: "dry" } }),
    },
  );
  return { ok: res.ok, status: res.status };
}

export async function triggerCanaryGapFill(
  deps: CanaryTriggerDeps,
): Promise<CanaryTriggerResult> {
  const { now, token, readHeartbeatMs, acquireDispatchLock, dispatch } = deps;
  const info = deps.onInfo ?? (() => {});
  const error = deps.onError ?? (() => {});

  const heartbeatMs = await readHeartbeatMs();
  // Never stamped: leave the first stamp to GitHub's own schedule; triggering on
  // null would also fire forever when the canary is not configured.
  if (heartbeatMs === null) return { dispatched: false, reason: "never-stamped" };
  // GitHub's schedule is keeping the heartbeat fresh: nothing to do.
  if (now - heartbeatMs <= CANARY_TRIGGER_STALE_MS) return { dispatched: false, reason: "fresh" };

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

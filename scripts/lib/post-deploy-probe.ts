/**
 * Post-deploy probe logic (#1037), kept dependency-free so it is node-testable.
 *
 * Every merge to main goes to 100% of traffic instantly and the deploy job used to
 * end at `pnpm cf:deploy`. Detection then fell to the scheduled canary: up to ~30
 * minutes for the dry tick, ~6h for booking-funnel breakage. Preview versions emit
 * no observability at all (docs/cloudflare-platform-notes.md), so they cannot serve
 * as a canary stage.
 *
 * THE THING THAT MAKES THIS A REAL CHECK RATHER THAN A COMFORTING ONE: it confirms
 * the live site is serving the commit that was just deployed, before judging its
 * health. A probe that only asks "does it return 200" passes against the PREVIOUS
 * version during the propagation window, so a completely broken deploy would report
 * healthy. That is the false-confidence class this repo keeps getting bitten by, and
 * a check that can pass while verifying nothing is worse than no check (#766).
 *
 * The corollary is that it must POLL rather than ask once: Cloudflare takes a moment
 * to serve a new version everywhere, so a single immediate request would fail
 * intermittently on timing. A gate that cries wolf gets ignored (L36), and this one
 * fails the deploy job, which pages.
 */

export interface ProbeStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProbeOutcome {
  ok: boolean;
  steps: ProbeStep[];
  /** Human summary for the GitHub annotation when it fails. */
  summary: string;
}

export interface ProbeDeps {
  /** Ask the live site which commit it is serving. Resolves null when unreachable
   *  or unreadable, which is a RETRY, not a failure: the old version answers here
   *  during propagation. */
  liveCommit: () => Promise<string | null>;
  /** The unauthenticated liveness signal: 200 plus its parsed body. */
  health: () => Promise<{ status: number; dbOk: boolean | null }>;
  /** The booker's read path for the isolated test bucket. */
  availability: () => Promise<{ status: number; slotsPresent: boolean }>;
  /** Injected so tests never wait. */
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface ProbeConfig {
  expectedCommit: string;
  /** How long to wait for the new version to appear before giving up. */
  versionTimeoutMs: number;
  /** Gap between version polls. */
  pollIntervalMs: number;
}

/**
 * How long to wait for the new version to become live before failing the deploy.
 *
 * Four minutes, sized from a MEASURED propagation rather than a guess: the first
 * real run (merge 81b6598, 2026-07-30) needed 10 polls, about 50 seconds. Two
 * minutes would have passed, but only about 2.4x headroom, and falling short
 * fails a perfectly good deploy and pages someone at whatever hour it happens.
 *
 * The asymmetry is what settles the number. Waiting longer costs nothing on a
 * healthy deploy, because the probe returns the moment the version appears; it
 * only extends the wait when something is already wrong. Being too short costs a
 * false page and, worse, trains everyone to disregard this alert (L36).
 */
export const DEFAULT_VERSION_TIMEOUT_MS = 240_000;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Wait until the live site reports `expectedCommit`.
 *
 * Returns the last commit seen on timeout so the failure can SAY what it saw
 * instead of "timed out": "still serving abc1234" and "never answered" are
 * different incidents and lead a reader to different places (L11).
 */
export async function waitForVersion(
  deps: Pick<ProbeDeps, "liveCommit" | "sleep" | "now">,
  cfg: Pick<ProbeConfig, "expectedCommit" | "versionTimeoutMs" | "pollIntervalMs">,
): Promise<{ matched: boolean; lastSeen: string | null; attempts: number }> {
  const deadline = deps.now() + cfg.versionTimeoutMs;
  let lastSeen: string | null = null;
  let attempts = 0;

  for (;;) {
    attempts++;
    lastSeen = await deps.liveCommit();
    if (lastSeen === cfg.expectedCommit) {
      return { matched: true, lastSeen, attempts };
    }
    // Check the deadline AFTER attempting, so a timeout of 0 still makes one
    // attempt: a probe that never even asks is the worst possible outcome.
    if (deps.now() >= deadline) {
      return { matched: false, lastSeen, attempts };
    }
    await deps.sleep(cfg.pollIntervalMs);
  }
}

/** Why the version never appeared, in words a reader can act on. */
export function versionFailureDetail(
  lastSeen: string | null,
  expected: string,
  attempts: number,
): string {
  if (lastSeen === null) {
    return `the version endpoint never answered after ${attempts} attempts; the deploy may have uploaded but the Worker is not serving, or the probe key is wrong`;
  }
  return `still serving ${lastSeen} after ${attempts} attempts, expected ${expected}; the upload succeeded but the new version is not live`;
}

/**
 * Run the whole probe. Every step is attempted and reported, rather than
 * short-circuiting on the first failure, EXCEPT that health and availability are
 * skipped when the version never appeared: judging the old version's health would
 * attribute someone else's result to this deploy.
 */
export async function runProbe(deps: ProbeDeps, cfg: ProbeConfig): Promise<ProbeOutcome> {
  const steps: ProbeStep[] = [];

  const version = await waitForVersion(deps, cfg);
  steps.push({
    name: "serving the deployed commit",
    ok: version.matched,
    detail: version.matched
      ? `${cfg.expectedCommit} live after ${version.attempts} attempt(s)`
      : versionFailureDetail(version.lastSeen, cfg.expectedCommit, version.attempts),
  });

  if (!version.matched) {
    return {
      ok: false,
      steps,
      summary:
        "the deployed commit never became live, so the app's health was not judged " +
        "(checking it would have measured the previous version)",
    };
  }

  const health = await deps.health();
  steps.push({
    name: "health endpoint",
    ok: health.status === 200,
    detail:
      health.status === 200
        ? "200, database reachable and no cron lane stale"
        : `${health.status}${health.dbOk === false ? ", database unreachable" : ""}`,
  });

  const avail = await deps.availability();
  // Status is the assertion; an empty slot list is NOT a failure (the isolated
  // test agents can legitimately be fully booked or outside working hours), so
  // asserting on it would produce exactly the flaky gate this must not be.
  steps.push({
    name: "availability read path",
    ok: avail.status === 200,
    detail:
      avail.status === 200
        ? `200${avail.slotsPresent ? ", slots present" : ", no slots offered (not asserted)"}`
        : `${avail.status}`,
  });

  const failed = steps.filter((s) => !s.ok);
  return {
    ok: failed.length === 0,
    steps,
    summary:
      failed.length === 0
        ? `the deployed commit is live and every probe passed`
        : `${failed.length} post-deploy check(s) failed: ${failed.map((s) => s.name).join(", ")}`,
  };
}

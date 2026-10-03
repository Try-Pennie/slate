/**
 * Refuse to deploy a commit unless `ci` passed on that EXACT commit (#3088).
 *
 * Native branch protection is a paid feature this org does not have, so nothing
 * prevents a direct push to main, and the main push guard (#1027) only detects one
 * after it has deployed. The deploy job's `needs: [ci, ...]` already waits on the
 * fan-in in the same run, but that is a property of one line of YAML: an edit to
 * `needs`, an `if: always()` added to the deploy job, or a re-run that reaches the
 * deploy some other way would ship with nothing checking. This is the second,
 * independent half: before anything is built, the deploy job asks GitHub for the
 * check runs named `ci` on the sha it is about to ship and refuses unless the newest
 * one finished green.
 *
 * Pure and dependency free: the decision is here and driven by
 * `scripts/test-deploy-ci-gate.ts`, the read is in `scripts/check-ci-before-deploy.ts`.
 */

/** The fields of a GitHub check run this reads. */
export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  app?: { slug?: string } | null;
}

/** The check name main-push-guard and the deploy both trust: the fan-in in ci.yml. */
export const CI_CHECK_NAME = "ci";
/** Who may author it. Any GitHub App with checks write could create a run called `ci`. */
export const CI_CHECK_APP = "github-actions";

export type DeployCiVerdict =
  | { ok: true; runId: number }
  | {
      ok: false;
      reason:
        | "bad-sha"
        | "no-ci-run"
        | "ci-not-finished"
        | "ci-not-green";
      detail: string;
    };

/**
 * The verdict for `sha` given the check runs GitHub returned for it.
 *
 * Only runs named `ci`, authored by GitHub Actions, on exactly `sha` are counted,
 * and the NEWEST of those decides, so re-running a flaked fan-in to green is a pass
 * while an older green run cannot vouch for a newer red one.
 */
export function judgeCiForDeploy(sha: string, runs: CheckRun[]): DeployCiVerdict {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return { ok: false, reason: "bad-sha", detail: `"${sha}" is not a full commit sha` };
  }
  const mine = runs.filter(
    (r) => r.name === CI_CHECK_NAME && r.head_sha === sha && r.app?.slug === CI_CHECK_APP,
  );
  if (mine.length === 0) {
    return {
      ok: false,
      reason: "no-ci-run",
      detail: `GitHub holds no \`${CI_CHECK_NAME}\` check run from ${CI_CHECK_APP} on ${sha}`,
    };
  }
  const newest = mine.reduce((a, b) => (b.id > a.id ? b : a));
  if (newest.status !== "completed") {
    return {
      ok: false,
      reason: "ci-not-finished",
      detail: `the newest \`${CI_CHECK_NAME}\` run on ${sha} (check run ${newest.id}) is ${newest.status}`,
    };
  }
  if (newest.conclusion !== "success") {
    return {
      ok: false,
      reason: "ci-not-green",
      detail: `the newest \`${CI_CHECK_NAME}\` run on ${sha} (check run ${newest.id}) concluded ${newest.conclusion ?? "nothing"}`,
    };
  }
  return { ok: true, runId: newest.id };
}

/** A read of the check runs: the parsed list, or why there is none. */
export type CheckRunsRead = { ok: true; runs: CheckRun[] } | { ok: false; error: string };

/**
 * Read with a bounded retry. A read that never succeeds REFUSES the deploy: an
 * unreadable answer is not a green one (L98), and retrying the deploy job later is
 * the cheap remedy. The sleep is injected so a test crosses the retries instantly
 * (L524).
 */
export async function readWithRetry(
  read: () => Promise<CheckRunsRead>,
  opts: { attempts: number; delayMs: number; sleep: (ms: number) => Promise<void> },
): Promise<CheckRunsRead & { attemptsUsed: number }> {
  let last: CheckRunsRead = { ok: false, error: "never attempted" };
  for (let i = 1; i <= opts.attempts; i++) {
    last = await read();
    if (last.ok) return { ...last, attemptsUsed: i };
    if (i < opts.attempts) await opts.sleep(opts.delayMs * i);
  }
  return { ...last, attemptsUsed: opts.attempts };
}

/** Parse the `GET /commits/{sha}/check-runs` body, refusing any other shape. */
export function parseCheckRuns(body: unknown): CheckRunsRead {
  const list = (body as { check_runs?: unknown } | null)?.check_runs;
  if (!Array.isArray(list)) return { ok: false, error: "the reply carried no check_runs list" };
  const runs: CheckRun[] = [];
  for (const r of list as Record<string, unknown>[]) {
    if (typeof r?.id !== "number" || typeof r.name !== "string" || typeof r.head_sha !== "string") {
      return { ok: false, error: "a check run in the reply was not the expected shape" };
    }
    runs.push({
      id: r.id,
      name: r.name,
      head_sha: r.head_sha,
      status: typeof r.status === "string" ? r.status : "unknown",
      conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
      app: (r.app as { slug?: string } | null) ?? null,
    });
  }
  return { ok: true, runs };
}

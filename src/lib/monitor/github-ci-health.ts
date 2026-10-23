/**
 * Two things about GitHub Actions that nothing inside Slate could see (#2476, #2229).
 *
 * Both are read from ONE listing of recent workflow runs, and both are here rather
 * than in a workflow for the same reason: an Actions workflow cannot report on
 * Actions being unavailable, and the run that would carry the report is the run that
 * did not happen. The Worker's monitor lane is the only thing in this system that
 * keeps running when GitHub does not.
 *
 * ## 1. A merge whose deploy was cancelled and never superseded (#2476)
 *
 * `ci.yml` cancels a superseded run on a branch and never on main, but a run on main
 * CAN still be cancelled (by a person, or by GitHub), and a cancelled run never
 * reaches `deploy`. Usually that is harmless: main is linear, so the next merge's run
 * deploys the tip and carries the earlier commits with it. **The gap is the LAST
 * merge of a burst.** Its work sits merged and undeployed with nothing saying so: the
 * pull request is merged, the issue is closed, `/api/health` is green because the
 * PREVIOUS version is serving perfectly well, and the only symptom is that the fix
 * somebody believes shipped is not running (L4).
 *
 * Measured 2026-09-16 during a run of nineteen merges: three runs on main were
 * cancelled with `deploy` absent. Each happened to be covered by a later merge, so
 * nothing was left behind that day. It self corrected only because more merges
 * followed.
 *
 * The check is a direct comparison rather than an inference: this build knows the
 * commit it was stamped with (`BUILD_COMMIT`, #1037), and the listing says which
 * commit is main's tip. If they differ for longer than the grace, main is built and
 * not live.
 *
 * ## 2. A run GitHub REFUSED to start, told from one that ran and failed (#2229)
 *
 * On 2026-09-10 every job on a pull request failed in about two seconds, under an
 * annotation that is visible in neither `gh pr checks` nor the checks list:
 *
 *   > The job was not started because recent account payments have failed or your
 *   > spending limit needs to be increased.
 *
 * In every surface a person looks at, that is ten red checks against a branch, which
 * reads as the change having broken something. The first move is to open a job log,
 * and there is no log, because the job never started. The two send two different
 * people to do two different things and today they read the same (L11).
 *
 * **The discriminator is the STEPS, not the annotation.** A job GitHub never started
 * concludes `failure` having executed zero steps; a job that ran has at least a
 * checkout. The annotation is the human readable evidence and needs a `checks: read`
 * scope this token is not guaranteed, so it is named in the alert as the thing to go
 * and read rather than being fetched.
 *
 * The verdict is deliberately "the jobs never started" and not "the account is out of
 * credit": a runner that could not be allocated produces the same zero step failure,
 * and both mean the same thing to the reader, which is that the red is not about the
 * change. Claiming a billing cause the check never measured would be a message
 * claiming more than its check (L11).
 *
 * ## What is NOT here, and why
 *
 * The second half of #2229 asks for the Actions balance, so the wall is visible
 * before it is hit. The org billing endpoint needs a token carrying `admin:org`,
 * which neither the default `GITHUB_TOKEN` nor the canary token has, so it waits on
 * the same fine grained token decision as #2264 rather than being guessed at here.
 *
 * Pure decisions over injected payloads: no network, no clock, no database in this
 * file's judgement, so every verdict is drivable offline
 * (`scripts/test-github-ci-health.ts`). The `fetch` glue at the bottom is the only
 * part that talks to GitHub, and it is the part the tests replace.
 */
import { parseStampMs } from "@/lib/date/stamp";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { explainedLabels } from "@/lib/notify/alert-folds";

/** The repo whose runs are read. Same repo the canary gap filler dispatches into. */
export const CI_REPO = "Try-Pennie/slate";

/**
 * How long main's tip may legitimately not be live.
 *
 * Derived, not chosen: the deploy job's own ceiling is 20 minutes
 * (`timeout-minutes` on `ci.yml`'s `deploy`), of which the post deploy probe may
 * spend 240s polling for Cloudflare to serve the new commit, and the whole run has to
 * finish `ci` and `migration-drift` first. A threshold under that would page about
 * every ordinary merge while its own deploy was still running. Measured deploys
 * complete in about 5 minutes end to end, so 30 minutes is the run's worst case with
 * room, and the monitor lane re-measures every 5 minutes, so a real gap is named
 * within one cooldown of it opening.
 */
export const DEPLOY_GRACE_MS = 30 * 60_000;

/**
 * The workflow whose run ships main, identified by PATH rather than by name.
 *
 * It has to be named, and naming it is not tidiness. `main-push-guard.yml` also runs
 * on every push to main, so "the newest push run on main" is routinely ITS run, whose
 * conclusion says nothing whatever about whether the deploy happened: a guard run that
 * succeeded beside a cancelled deploy would read as main having shipped. A proxy
 * answering for the quantity being protected is the defect this whole family exists to
 * catch (L63).
 *
 * `scripts/test-github-ci-health.ts` reads the real file and fails if it stops being
 * the workflow that deploys, so a rename or a moved `deploy` job is caught here rather
 * than by this check silently finding no run and going quiet.
 */
export const DEPLOY_WORKFLOW_PATH = ".github/workflows/ci.yml";

/** One workflow run, reduced to what either judgement reads. */
export interface WorkflowRunSummary {
  id: number;
  /** The workflow's display name, for the message. */
  name: string;
  headSha: string;
  /** `push`, `pull_request`, `schedule`, `workflow_dispatch`. */
  event: string;
  /** The workflow file, which is the only stable way to say WHICH workflow ran. */
  path: string;
  branch: string;
  /** `queued`, `in_progress`, `completed`. */
  status: string | null;
  /** `success`, `failure`, `cancelled`, `startup_failure`, `skipped`, or null. */
  conclusion: string | null;
  /** When the run was created, or null when the stamp could not be read. */
  createdAtMs: number | null;
  htmlUrl: string;
}

/** One job of a run, reduced to the only thing that tells a refusal from a failure. */
export interface WorkflowJobSummary {
  name: string;
  conclusion: string | null;
  /** How many steps the job executed. ZERO is the whole signal. */
  stepCount: number;
}

/**
 * Read GitHub's runs payload into summaries.
 *
 * Every field is checked rather than cast: this is an external response and the
 * shapes that matter here (a sha, a conclusion) decide whether somebody is paged
 * (L23). A row missing a sha or a url is DROPPED rather than defaulted, because a
 * run with an empty sha would compare unequal to every commit and read as main
 * never being live.
 */
export function parseWorkflowRuns(payload: unknown): WorkflowRunSummary[] {
  const runs = (payload as { workflow_runs?: unknown })?.workflow_runs;
  if (!Array.isArray(runs)) return [];
  const out: WorkflowRunSummary[] = [];
  for (const raw of runs) {
    const r = raw as Record<string, unknown>;
    const headSha = typeof r.head_sha === "string" ? r.head_sha : "";
    const htmlUrl = typeof r.html_url === "string" ? r.html_url : "";
    const id = typeof r.id === "number" ? r.id : null;
    if (!headSha || !htmlUrl || id === null) continue;
    out.push({
      id,
      name: typeof r.name === "string" && r.name ? r.name : "a workflow",
      headSha,
      event: typeof r.event === "string" ? r.event : "",
      path: typeof r.path === "string" ? r.path : "",
      branch: typeof r.head_branch === "string" ? r.head_branch : "",
      status: typeof r.status === "string" ? r.status : null,
      conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
      createdAtMs: parseStampMs(typeof r.created_at === "string" ? r.created_at : null),
      htmlUrl,
    });
  }
  return out;
}

/** Read GitHub's jobs payload. A row with no readable steps array counts ZERO. */
export function parseWorkflowJobs(payload: unknown): WorkflowJobSummary[] {
  const jobs = (payload as { jobs?: unknown })?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.map((raw) => {
    const j = raw as Record<string, unknown>;
    return {
      name: typeof j.name === "string" && j.name ? j.name : "a job",
      conclusion: typeof j.conclusion === "string" ? j.conclusion : null,
      stepCount: Array.isArray(j.steps) ? j.steps.length : 0,
    };
  });
}

/**
 * Whether the deployment's stamped commit is the run's commit.
 *
 * `BUILD_COMMIT` is the sha truncated to 12 characters and GitHub reports 40, so this
 * compares on the SHORTER of the two and refuses an empty or placeholder value
 * outright. An empty string is a prefix of everything, so a loose comparison would
 * report a build carrying no stamp at all as serving whatever the tip happens to be.
 */
export function sameCommit(served: string, headSha: string): boolean {
  const a = served.trim().toLowerCase();
  const b = headSha.trim().toLowerCase();
  if (a.length < 7 || b.length < 7) return false;
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

export type DeployState =
  /** Nothing could be judged. Never pages, never clears. */
  | { state: "unmeasured"; why: string }
  /** The deployment is serving main's tip. */
  | { state: "live"; sha: string }
  /** The tip's run is still going, or is inside the grace. Normal. */
  | { state: "in-flight"; run: WorkflowRunSummary }
  /** Main's tip is not live and its run has finished. */
  | {
      state: "not-live";
      /** How the tip's run ended, which decides who is already being told. */
      reason: "cancelled" | "succeeded" | "failed" | "unknown";
      run: WorkflowRunSummary;
      servedCommit: string;
      behindMs: number;
    };

/**
 * Is main's tip live?
 *
 * The comparison is against the newest PUSH run on main, which is the run that
 * belongs to the tip. A run still in progress, or one younger than the grace, is
 * in flight rather than a finding: every ordinary merge passes through that state.
 */
export function judgeDeployedTip(args: {
  servedCommit: string;
  newestMainRun: WorkflowRunSummary | null;
  nowMs: number;
  graceMs?: number;
}): DeployState {
  const graceMs = args.graceMs ?? DEPLOY_GRACE_MS;
  const served = args.servedCommit.trim();
  if (served.length < 7) {
    return {
      state: "unmeasured",
      why: "this build carries no commit stamp, so it cannot say which commit it is serving",
    };
  }
  const run = args.newestMainRun;
  if (!run) {
    return { state: "unmeasured", why: "no push run on main could be read" };
  }
  if (sameCommit(served, run.headSha)) {
    return { state: "live", sha: run.headSha.slice(0, 12) };
  }
  if (run.status !== "completed") {
    return { state: "in-flight", run };
  }
  if (run.createdAtMs === null) {
    return {
      state: "unmeasured",
      why: "the newest run on main carries a start time this cannot read, so how long it has been undeployed is unknown",
    };
  }
  const behindMs = args.nowMs - run.createdAtMs;
  if (behindMs <= graceMs) return { state: "in-flight", run };

  const reason: "cancelled" | "succeeded" | "failed" | "unknown" =
    run.conclusion === "cancelled"
      ? "cancelled"
      : run.conclusion === "success"
        ? "succeeded"
        : run.conclusion === "failure" || run.conclusion === "startup_failure"
          ? "failed"
          : "unknown";
  return { state: "not-live", reason, run, servedCommit: served.slice(0, 12), behindMs };
}

/**
 * Whether a `not-live` verdict is one this check should page about.
 *
 * A run that FAILED on main already pages through `.github/workflows/deploy-alert.yml`
 * (#122), which fires on exactly that. Paging again here would be two messages about
 * one fact, and a second pager saying the same thing is how both stop being read
 * (L36). The state is still counted and logged, so a reader of the tick line sees it.
 *
 * Every other ending is uncovered and pages: `cancelled` is the state this was opened
 * about, `succeeded` means the run reported success and the commit still is not being
 * served (a skipped deploy job, or a deploy that did not take), and `unknown` is an
 * ending nothing here recognises, which is exactly when a human should look.
 */
export function deployStatePages(verdict: DeployState): boolean {
  return verdict.state === "not-live" && verdict.reason !== "failed";
}

export type RunNature = "never-started" | "ran-and-failed" | "unreadable";

/**
 * Did the jobs of a failed run actually run?
 *
 * A job GitHub refused to start concludes `failure` having executed ZERO steps. A job
 * that really failed executed at least its checkout. So: if every failed job of the
 * run executed nothing, nothing ran.
 *
 * `unreadable` rather than a guess when there are no jobs to look at, or none of them
 * failed: a run reported failed whose jobs say otherwise is a payload this does not
 * understand, and answering it either way would be a verdict nothing measured (L98).
 */
export function classifyFailedRun(jobs: WorkflowJobSummary[]): RunNature {
  if (jobs.length === 0) return "unreadable";
  const failed = jobs.filter(
    (j) => j.conclusion === "failure" || j.conclusion === "startup_failure",
  );
  if (failed.length === 0) return "unreadable";
  return failed.every((j) => j.stepCount === 0) ? "never-started" : "ran-and-failed";
}

export type CiStartState =
  | { state: "unmeasured"; why: string }
  /** Something recently RAN, whatever it concluded. Jobs are starting. */
  | { state: "starting"; run: WorkflowRunSummary }
  /** The newest completed run's jobs never started. */
  | { state: "refused"; run: WorkflowRunSummary };

/** A run whose conclusion is proof that its jobs started, with no jobs read. */
const STARTED_CONCLUSIONS = new Set(["success", "cancelled", "timed_out", "action_required"]);

/**
 * Are CI jobs starting at all?
 *
 * Judged on the NEWEST COMPLETED run of any workflow on any branch, because a refusal
 * hits everything at once: the 2026-09-10 incident was a pull request, and the
 * compensating control over main (`main-push-guard.yml`, #1027) is itself an Actions
 * workflow, so it could not run either.
 *
 * `readJobs` is only called when the newest completed run FAILED, so a healthy repo
 * spends no extra request on this.
 */
export async function judgeCiStart(args: {
  runs: WorkflowRunSummary[];
  readJobs: (runId: number) => Promise<WorkflowJobSummary[] | null>;
}): Promise<CiStartState> {
  const newest = args.runs.find((r) => r.status === "completed");
  if (!newest) {
    return {
      state: "unmeasured",
      why: "no completed workflow run could be read, so nothing says whether jobs are starting",
    };
  }
  if (newest.conclusion !== null && STARTED_CONCLUSIONS.has(newest.conclusion)) {
    return { state: "starting", run: newest };
  }
  if (newest.conclusion !== "failure" && newest.conclusion !== "startup_failure") {
    return {
      state: "unmeasured",
      why: `the newest completed run ended as ${newest.conclusion ?? "nothing this can read"}, which says nothing either way`,
    };
  }
  const jobs = await args.readJobs(newest.id);
  if (jobs === null) {
    return { state: "unmeasured", why: "the failed run's jobs could not be read" };
  }
  const nature = classifyFailedRun(jobs);
  if (nature === "never-started") return { state: "refused", run: newest };
  if (nature === "ran-and-failed") return { state: "starting", run: newest };
  return {
    state: "unmeasured",
    why: "the failed run's jobs do not say whether they executed anything",
  };
}

/* --------------------------------------------------------------------------
 * Copy. Built here and nowhere else, so `pnpm preview:alerts` renders exactly
 * what ships (L41).
 * -------------------------------------------------------------------------- */

function minutesWord(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 120) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** What each ending means for the reader, and what to do about it. */
const NOT_LIVE_REASON: Record<"cancelled" | "succeeded" | "failed" | "unknown", string> = {
  cancelled:
    "Its run was cancelled, and a cancelled run never reaches the deploy job. Nothing has followed it, so nothing will carry it live on its own. Re-run the deploy job on that run, or push an empty commit to main.",
  succeeded:
    "Its run reported success, so the deploy job either was skipped or did not take. Open the run and look at the deploy job before re-running it.",
  failed:
    "Its run failed, so the deploy job never ran. Fix the failure and merge, or re-run the run once it can pass.",
  unknown:
    "Its run ended in a way this check does not recognise, so somebody has to look at it.",
};

export function formatDeployNotLiveAlert(v: {
  reason: "cancelled" | "succeeded" | "failed" | "unknown";
  tipSha: string;
  servedCommit: string;
  behindMs: number;
  runUrl: string;
}): string {
  return [
    `Main is merged and not live. The site is serving ${v.servedCommit} while main's tip is ${v.tipSha.slice(0, 12)}, ${minutesWord(v.behindMs)} after that commit landed.`,
    NOT_LIVE_REASON[v.reason],
    `Run: ${v.runUrl}`,
  ].join("\n");
}

export function formatDeployLiveRecovery(sha: string): string {
  return `Main's tip is live again: the site is serving ${sha.slice(0, 12)}.`;
}

/** "a, b and c", for the alerts a refusal explains. */
function joinedLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function capitalised(text: string): string {
  return text === "" ? text : `${text[0].toUpperCase()}${text.slice(1)}`;
}

/**
 * The page names the alerts it speaks for while it is open (#3802), from the one fold
 * table the throttle reads (`src/lib/notify/alert-folds.ts`), so an entry added there
 * is named here without anybody remembering to. Its all-clear does the same.
 */
export function formatCiRefusedAlert(v: { runName: string; runUrl: string }): string {
  const explains = explainedLabels(REFUSAL_ALERT_KEY);
  return [
    `GitHub refused to start the jobs on the newest CI run, so the red checks are not about the change: nothing ran, and there is no log to read.`,
    `Open the run and read the annotation on any job. A failed payment or an exhausted spending limit is the usual cause, and neither shows up in the checks list.`,
    `While this lasts nothing server side is watching main: the push guard is itself a workflow, so it cannot run either.`,
    ...(explains.length > 0
      ? [
          `${capitalised(joinedLabels(explains))} run on GitHub Actions too, so they have stopped as well and nothing is checking a booking end to end. Any of them that goes quiet while this is open is not paged separately.`,
        ]
      : []),
    `Run: ${v.runName} at ${v.runUrl}`,
  ].join("\n");
}

export function formatCiStartedRecovery(): string {
  const explains = explainedLabels(REFUSAL_ALERT_KEY);
  const first = "CI jobs are starting again: the newest run executed its steps rather than being refused.";
  if (explains.length === 0) return first;
  return `${first} Of ${joinedLabels(explains)}, any that went quiet during the refusal gets one full cycle of its own to report in, and alerts on its own only if it is still quiet after that.`;
}

/* --------------------------------------------------------------------------
 * The one GitHub read, and the check that turns it into two verdicts.
 * -------------------------------------------------------------------------- */

/**
 * How long any GitHub API call from the monitor lane may wait (#3972). GitHub answers
 * these in well under a second; a hang must end as a reported failure, never as a
 * lane stalled until the platform kills it, which skips every alert below it.
 */
export const GITHUB_API_TIMEOUT_MS = 10_000;

const GITHUB_HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  // GitHub rejects API calls with no User-Agent.
  "user-agent": "slate-ci-health",
});

/**
 * The newest runs across every workflow and branch, in one request.
 *
 * ONE listing answers both questions: the deploy comparison filters it to push runs
 * on main, and the refusal check reads the newest completed run whatever it is. A
 * second, narrower request per question would double this check's cost on an
 * invocation four cron lanes share, for nothing.
 */
export async function fetchRecentRuns(
  token: string,
  perPage = 30,
): Promise<WorkflowRunSummary[] | null> {
  const res = await fetch(
    `https://api.github.com/repos/${CI_REPO}/actions/runs?per_page=${perPage}`,
    { headers: GITHUB_HEADERS(token), signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  return parseWorkflowRuns(await res.json());
}

export async function fetchRunJobs(
  token: string,
  runId: number,
): Promise<WorkflowJobSummary[] | null> {
  const res = await fetch(
    `https://api.github.com/repos/${CI_REPO}/actions/runs/${runId}/jobs?per_page=50`,
    { headers: GITHUB_HEADERS(token), signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  return parseWorkflowJobs(await res.json());
}

export interface CiHealthResult {
  deploy: DeployState["state"] | "not-measured";
  deployReason: string | null;
  ciStart: CiStartState["state"];
}

export interface CiHealthDeps {
  nowMs: number;
  /** The commit this build was stamped with. "dev" locally, which is unmeasurable. */
  servedCommit: string;
  /** GITHUB_CANARY_TOKEN. Empty means quiet no-op, like the gap filler. */
  token: string;
  readRuns: (token: string) => Promise<WorkflowRunSummary[] | null>;
  readJobs: (token: string, runId: number) => Promise<WorkflowJobSummary[] | null>;
  cooldownMs: { deploy: number; refusal: number };
  notify: ThrottledNotify<unknown>;
  resolve: AlertResolve<unknown>;
  log?: (msg: string, fields: Record<string, unknown>) => void;
  onError?: (msg: string, err?: unknown) => void;
  graceMs?: number;
}

export const DEPLOY_ALERT_KEY = "main_not_deployed";
export const REFUSAL_ALERT_KEY = "ci_runs_refused";

/**
 * Read once, judge twice, and never throw: this runs on a cron lane.
 *
 * Neither verdict CLEARS on anything but a measured healthy reading. An unreadable
 * listing resolves nothing and pages nothing, because a run that measured nothing
 * must not announce a recovery (#1134, #1152).
 */
export async function runCiHealthCheck(deps: CiHealthDeps): Promise<CiHealthResult> {
  const log = deps.log ?? (() => {});
  if (!deps.token) {
    return { deploy: "not-measured", deployReason: "no github token", ciStart: "unmeasured" };
  }

  let runs: WorkflowRunSummary[] | null = null;
  try {
    runs = await deps.readRuns(deps.token);
  } catch (err) {
    (deps.onError ?? (() => {}))("ci-health: the runs listing threw", err);
    runs = null;
  }
  if (runs === null) {
    // Null, never an empty list: an empty listing would say main's tip cannot be
    // found AND that no run has ever started, which are two confident findings
    // drawn from a read that failed (L215).
    return { deploy: "not-measured", deployReason: "runs listing unreadable", ciStart: "unmeasured" };
  }

  // The DEPLOYING workflow's push run on main, never merely the newest push run on
  // main: `main-push-guard.yml` fires on every one of those too, and its conclusion
  // says nothing about whether the deploy happened.
  const newestMainRun =
    runs.find(
      (r) => r.event === "push" && r.branch === "main" && r.path === DEPLOY_WORKFLOW_PATH,
    ) ?? null;
  const deploy = judgeDeployedTip({
    servedCommit: deps.servedCommit,
    newestMainRun,
    nowMs: deps.nowMs,
    graceMs: deps.graceMs,
  });

  if (deployStatePages(deploy) && deploy.state === "not-live") {
    // alert-text-ok: our own copy from this file, never a raw error.
    await deps.notify(
      DEPLOY_ALERT_KEY,
      deps.cooldownMs.deploy,
      formatDeployNotLiveAlert({
        reason: deploy.reason,
        tipSha: deploy.run.headSha,
        servedCommit: deploy.servedCommit,
        behindMs: deploy.behindMs,
        runUrl: deploy.run.htmlUrl,
      }),
    );
  } else if (deploy.state === "live") {
    await deps.resolve(DEPLOY_ALERT_KEY, formatDeployLiveRecovery(deploy.sha));
  }

  let ciStart: CiStartState;
  try {
    ciStart = await judgeCiStart({
      runs,
      readJobs: (runId) => deps.readJobs(deps.token, runId),
    });
  } catch (err) {
    (deps.onError ?? (() => {}))("ci-health: the jobs read threw", err);
    ciStart = { state: "unmeasured", why: "the failed run's jobs could not be read" };
  }

  if (ciStart.state === "refused") {
    // alert-text-ok: our own copy from this file, never a raw error.
    await deps.notify(
      REFUSAL_ALERT_KEY,
      deps.cooldownMs.refusal,
      formatCiRefusedAlert({ runName: ciStart.run.name, runUrl: ciStart.run.htmlUrl }),
      // #3801: no subjects. The condition is the account refusing jobs, whichever
      // run happened to be newest; the run name and link differ on every post, so
      // as subjects they would make each refused run a new problem (10 posts in a
      // night of one billing stop). It is said again once a day while it lasts.
      { subjects: [] },
    );
  } else if (ciStart.state === "starting") {
    await deps.resolve(REFUSAL_ALERT_KEY, formatCiStartedRecovery());
  }

  log("tick", {
    deploy: deploy.state,
    deploy_reason: deploy.state === "not-live" ? deploy.reason : null,
    ci_start: ciStart.state,
    runs_read: runs.length,
  });

  return {
    deploy: deploy.state,
    deployReason: deploy.state === "not-live" ? deploy.reason : null,
    ciStart: ciStart.state,
  };
}

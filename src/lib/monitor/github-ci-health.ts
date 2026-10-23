/**
 * Two things about GitHub Actions that nothing inside Slate could see (#2476, #2229).
 *
 * Both read ONE shared listing of recent workflow runs; the deploy judgement also reads
 * main's tip from the branch and, when the listing lacks the tip's run, that run by sha
 * (#3648). Both are here rather than in a workflow for the same reason: an Actions workflow cannot report on
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
 * commit it was stamped with (`BUILD_COMMIT`, #1037), and the BRANCH says which
 * commit is main's tip (#3648: it used to be inferred from the newest run, which a
 * merge GitHub never ran left pointing at the previous merge, reading as live). If
 * they differ for longer than the grace, main is not live, and the tip's own run, or
 * its absence, says why.
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

/**
 * How main's tip came to be not live. `no-run` (#3648) is a tip GitHub never started a
 * deploying run for, so there is no run to name and no workflow that will report it.
 */
export type NotLiveReason = "cancelled" | "succeeded" | "failed" | "unknown" | "no-run";

export type DeployState =
  /** Nothing could be judged. Never pages, never clears. */
  | { state: "unmeasured"; why: string }
  /** The deployment is serving main's tip. */
  | { state: "live"; sha: string }
  /** The tip's run is still going, or is inside the grace (null: not registered yet). Normal. */
  | { state: "in-flight"; run: WorkflowRunSummary | null }
  /** Main's tip is not live and its run has finished, or never started. */
  | {
      state: "not-live";
      /** How the tip's run ended, which decides who is already being told. */
      reason: NotLiveReason;
      /** Main's tip, the commit that should be live. */
      tipSha: string;
      /** The tip's own deploying run; null only for `no-run`. */
      run: WorkflowRunSummary | null;
      servedCommit: string;
      behindMs: number;
    };

/** Main's tip as the branch reports it (#3648), the commit that is expected to be live. */
export interface MainTip {
  sha: string;
  /** When that commit landed (its committer date), or null when unreadable. */
  committedAtMs: number | null;
}

/**
 * Read GitHub's `commits/main` payload. Null, never a default, for a payload with no
 * usable sha: an empty tip would compare unequal to every commit and read as main never
 * being live (the same reason `parseWorkflowRuns` drops such a row).
 */
export function parseMainTip(payload: unknown): MainTip | null {
  const p = payload as { sha?: unknown; commit?: { committer?: { date?: unknown } } } | null;
  const sha = typeof p?.sha === "string" ? p.sha.trim() : "";
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  const date = p?.commit?.committer?.date;
  return { sha, committedAtMs: parseStampMs(typeof date === "string" ? date : null) };
}

/**
 * Is main's tip live?
 *
 * `newestMainRun` must be the deploying run FOR main's tip, found by the tip's sha
 * (`judgeDeployAgainstTip`, #3648), never merely the newest push run on main: a merge
 * GitHub never ran leaves the previous merge's run newest, and judging that one read as
 * live. A run still in progress, or one younger than the grace, is in flight rather
 * than a finding: every ordinary merge passes through that state.
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

  const reason: NotLiveReason =
    run.conclusion === "cancelled"
      ? "cancelled"
      : run.conclusion === "success"
        ? "succeeded"
        : run.conclusion === "failure" || run.conclusion === "startup_failure"
          ? "failed"
          : "unknown";
  return { state: "not-live", reason, tipSha: run.headSha, run, servedCommit: served.slice(0, 12), behindMs };
}

/**
 * Main's tip is not being served and GitHub holds no deploying run for it (#3648).
 *
 * Within the grace of the commit landing that is every merge, whose run has not
 * registered yet. Past it, nothing built or deployed the commit and no workflow will
 * say so, because the workflow is what did not happen. An unreadable landing time
 * cannot say which side of the grace it is on, so it measures nothing (L50).
 */
export function judgeTipWithoutRun(args: {
  servedCommit: string;
  tip: MainTip;
  nowMs: number;
  graceMs?: number;
}): DeployState {
  const graceMs = args.graceMs ?? DEPLOY_GRACE_MS;
  if (args.tip.committedAtMs === null) {
    return {
      state: "unmeasured",
      why: "main's tip has no deploying run and its landing time cannot be read, so whether it is overdue is unknown",
    };
  }
  const behindMs = args.nowMs - args.tip.committedAtMs;
  if (behindMs <= graceMs) return { state: "in-flight", run: null };
  return {
    state: "not-live",
    reason: "no-run",
    tipSha: args.tip.sha,
    run: null,
    servedCommit: args.servedCommit.trim().slice(0, 12),
    behindMs,
  };
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
const NOT_LIVE_REASON: Record<NotLiveReason, string> = {
  "no-run":
    "GitHub never started a CI run for it, so nothing built or deployed it, and no workflow will report that. Check githubstatus.com for an Actions incident; once Actions is working, push an empty commit to main to start a run.",
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
  reason: NotLiveReason;
  tipSha: string;
  servedCommit: string;
  behindMs: number;
  /** The tip's run; null when there is none (`no-run`), and the commit is linked instead. */
  runUrl: string | null;
}): string {
  return [
    `Main is merged and not live. The site is serving ${v.servedCommit} while main's tip is ${v.tipSha.slice(0, 12)}, ${minutesWord(v.behindMs)} after that commit landed.`,
    NOT_LIVE_REASON[v.reason],
    v.runUrl ? `Run: ${v.runUrl}` : `Commit: https://github.com/${CI_REPO}/commit/${v.tipSha}`,
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
 * Shared by both questions: the deploy comparison looks in it for the tip's own run
 * (falling back to `fetchTipRuns` only when it is not there, #3648), and the refusal
 * check reads the newest completed run whatever it is. A separate listing per question
 * would double this check's cost on an invocation four cron lanes share, for nothing.
 */
export async function fetchRecentRuns(
  token: string,
  perPage = 30,
): Promise<WorkflowRunSummary[] | null> {
  const res = await fetch(
    `https://api.github.com/repos/${CI_REPO}/actions/runs?per_page=${perPage}`,
    { headers: GITHUB_HEADERS(token) },
  );
  if (!res.ok) return null;
  return parseWorkflowRuns(await res.json());
}

/** Main's tip, read from the branch itself (#3648). Null on any failure. */
export async function fetchMainTip(token: string): Promise<MainTip | null> {
  const res = await fetch(`https://api.github.com/repos/${CI_REPO}/commits/main`, {
    headers: GITHUB_HEADERS(token),
  });
  if (!res.ok) return null;
  return parseMainTip(await res.json());
}

/**
 * The deploying workflow's push runs for one commit (#3648), for when the shared
 * listing does not hold the tip's run. Null, never an empty list, when the reply is not
 * a runs payload: an empty list here means "GitHub has no run for this commit", which
 * pages, so it must only ever come from a reply that said so (L215).
 */
export async function fetchTipRuns(token: string, sha: string): Promise<WorkflowRunSummary[] | null> {
  const workflow = DEPLOY_WORKFLOW_PATH.split("/").pop();
  const res = await fetch(
    `https://api.github.com/repos/${CI_REPO}/actions/workflows/${workflow}/runs?event=push&branch=main&head_sha=${encodeURIComponent(sha)}&per_page=5`,
    { headers: GITHUB_HEADERS(token) },
  );
  if (!res.ok) return null;
  const payload = (await res.json()) as { workflow_runs?: unknown };
  if (!Array.isArray(payload?.workflow_runs)) return null;
  return parseWorkflowRuns(payload);
}

export async function fetchRunJobs(
  token: string,
  runId: number,
): Promise<WorkflowJobSummary[] | null> {
  const res = await fetch(
    `https://api.github.com/repos/${CI_REPO}/actions/runs/${runId}/jobs?per_page=50`,
    { headers: GITHUB_HEADERS(token) },
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
  /** Main's tip, the commit expected to be live (#3648). Null when unreadable. */
  readMainTip: (token: string) => Promise<MainTip | null>;
  /** The deploying runs for one commit; null when unreadable, [] when there are none. */
  readTipRuns: (token: string, sha: string) => Promise<WorkflowRunSummary[] | null>;
  cooldownMs: { deploy: number; refusal: number };
  notify: ThrottledNotify<unknown>;
  resolve: AlertResolve<unknown>;
  log?: (msg: string, fields: Record<string, unknown>) => void;
  onError?: (msg: string, err?: unknown) => void;
  graceMs?: number;
}

/**
 * Is main's tip live, judged against the commit main ACTUALLY points at (#3648, L760)?
 *
 * This used to take the tip to be the commit of the newest deploying run in the
 * listing. A merge GitHub never started a run for left the previous merge's run newest,
 * and that commit is the one being served, so the check said "live" and cleared the
 * page while the merge sat unbuilt. Only the expected commit's OWN run may explain why
 * it is not live; any other run says nothing about it.
 *
 * Never throws: a failed read is unmeasured, which pages nothing and clears nothing.
 */
async function judgeDeployAgainstTip(deps: CiHealthDeps, runs: WorkflowRunSummary[]): Promise<DeployState> {
  const onError = deps.onError ?? (() => {});
  if (deps.servedCommit.trim().length < 7) {
    // Checked before any read: an unstamped build cannot be compared with anything.
    return { state: "unmeasured", why: "this build carries no commit stamp, so it cannot say which commit it is serving" };
  }
  let tip: MainTip | null = null;
  try {
    tip = await deps.readMainTip(deps.token);
  } catch (err) {
    onError("ci-health: the main tip read threw", err);
  }
  if (tip === null) return { state: "unmeasured", why: "main's tip could not be read" };
  if (sameCommit(deps.servedCommit, tip.sha)) return { state: "live", sha: tip.sha.slice(0, 12) };

  // The DEPLOYING workflow's push run on main FOR THE TIP, never merely the newest push
  // run on main: `main-push-guard.yml` fires on every push too, and an earlier merge's
  // run says nothing about this one.
  const isTipRun = (r: WorkflowRunSummary) =>
    r.event === "push" && r.branch === "main" && r.path === DEPLOY_WORKFLOW_PATH && sameCommit(r.headSha, tip.sha);
  let tipRun = runs.find(isTipRun) ?? null;
  if (!tipRun) {
    // Not in the shared listing: it may have scrolled out under pull request runs, so
    // ask for it directly before concluding there is none.
    let direct: WorkflowRunSummary[] | null = null;
    try {
      direct = await deps.readTipRuns(deps.token, tip.sha);
    } catch (err) {
      onError("ci-health: the tip run read threw", err);
    }
    if (direct === null) return { state: "unmeasured", why: "main's tip run could not be looked up" };
    tipRun = direct.find(isTipRun) ?? null;
  }
  if (!tipRun) {
    return judgeTipWithoutRun({ servedCommit: deps.servedCommit, tip, nowMs: deps.nowMs, graceMs: deps.graceMs });
  }
  return judgeDeployedTip({ servedCommit: deps.servedCommit, newestMainRun: tipRun, nowMs: deps.nowMs, graceMs: deps.graceMs });
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

  const deploy = await judgeDeployAgainstTip(deps, runs);

  if (deployStatePages(deploy) && deploy.state === "not-live") {
    // alert-text-ok: our own copy from this file, never a raw error.
    await deps.notify(
      DEPLOY_ALERT_KEY,
      deps.cooldownMs.deploy,
      formatDeployNotLiveAlert({
        reason: deploy.reason,
        tipSha: deploy.tipSha,
        servedCommit: deploy.servedCommit,
        behindMs: deploy.behindMs,
        runUrl: deploy.run?.htmlUrl ?? null,
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

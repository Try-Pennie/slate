// A merge that never deployed, and a CI run GitHub refused to start (#2476, #2229).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-github-ci-health.ts
//
// Both judgements read GitHub, so what has to be pinned is the DECISION rather than
// the answer on any given day. Everything here is driven through hand written
// payloads with no network and no clock, and each verdict is produced by a case
// rather than asserted about in the abstract.
//
// The controls that matter, in both directions:
//
//   - a cancelled run on main that IS being served must NOT page, or the check
//     reports every healthy deploy as a fault;
//   - a merge still inside the grace must NOT page, or every ordinary merge is one;
//   - a run that failed on main must not page HERE, because deploy-alert.yml already
//     does and two pagers about one fact is how both stop being read (L36);
//   - a run whose jobs really ran must NOT be reported as refused, or the one
//     signal that tells a person "this red is not about your change" becomes noise.
import {
  classifyFailedRun,
  deployStatePages,
  formatCiRefusedAlert,
  formatDeployNotLiveAlert,
  judgeCiStart,
  judgeDeployedTip,
  parseMainTip,
  parseWorkflowJobs,
  parseWorkflowRuns,
  runCiHealthCheck,
  sameCommit,
  DEPLOY_ALERT_KEY,
  DEPLOY_GRACE_MS,
  DEPLOY_WORKFLOW_PATH,
  REFUSAL_ALERT_KEY,
  type WorkflowJobSummary,
  type WorkflowRunSummary,
} from "../src/lib/monitor/github-ci-health.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const TIP = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const PREV = "9988776655443322110099887766554433221100";

function run(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  const merged = {
    id: 1,
    name: "CI",
    headSha: TIP,
    event: "push",
    path: ".github/workflows/ci.yml",
    branch: "main",
    status: "completed",
    conclusion: "success",
    createdAtMs: NOW - 60 * 60_000,
    htmlUrl: "",
    ...over,
  };
  // Derived from the id rather than fixed, so a case with two runs can assert WHICH
  // one the message links. A shared url would let the wrong run satisfy that.
  return {
    ...merged,
    htmlUrl: merged.htmlUrl || `https://github.com/Try-Pennie/slate/actions/runs/${merged.id}`,
  };
}

// --- sameCommit ----------------------------------------------------------------
//
// BUILD_COMMIT is the sha truncated to 12 characters and GitHub reports 40, so a
// naive equality would report every deployment as behind. The opposite mistake is
// worse: an empty string is a prefix of everything, so a loose prefix comparison
// would report a build carrying no stamp as serving whatever the tip happens to be.
{
  assert(sameCommit(TIP.slice(0, 12), TIP), "a 12 character stamp matches the full sha");
  assert(!sameCommit(PREV.slice(0, 12), TIP), "a different commit does not match");
  assert(!sameCommit("", TIP), "an empty stamp matches nothing");
  assert(!sameCommit("dev", TIP), "the local placeholder matches nothing");
  assert(sameCommit(TIP.toUpperCase().slice(0, 12), TIP), "case does not decide it");
}

// --- the deploy comparison -----------------------------------------------------
{
  const v = judgeDeployedTip({ servedCommit: TIP.slice(0, 12), newestMainRun: run(), nowMs: NOW });
  eq(v.state, "live", "serving the tip is live");
  assert(!deployStatePages(v), "and pages nothing");
}
{
  // The state #2476 was opened about: the last merge of a burst, cancelled, with
  // nothing following it. Merged, closed, green health check, and not running.
  const v = judgeDeployedTip({
    servedCommit: PREV.slice(0, 12),
    newestMainRun: run({ conclusion: "cancelled" }),
    nowMs: NOW,
  });
  eq(v.state, "not-live", "a cancelled run whose commit is not being served is a finding");
  assert(v.state === "not-live" && v.reason === "cancelled", "named as cancelled");
  assert(deployStatePages(v), "and it pages, because nothing else reports it");
}
{
  // The control that stops the check firing on every merge: a run still going.
  const v = judgeDeployedTip({
    servedCommit: PREV.slice(0, 12),
    newestMainRun: run({ status: "in_progress", conclusion: null, createdAtMs: NOW - 60_000 }),
    nowMs: NOW,
  });
  eq(v.state, "in-flight", "a run still going is in flight, not a finding");
  assert(!deployStatePages(v), "and pages nothing");
}
{
  // And one finished but inside the grace: a deploy takes minutes, and the lane
  // measures every five, so the commonest moment to look is mid deploy.
  const v = judgeDeployedTip({
    servedCommit: PREV.slice(0, 12),
    newestMainRun: run({ conclusion: "cancelled", createdAtMs: NOW - (DEPLOY_GRACE_MS - 60_000) },),
    nowMs: NOW,
  });
  eq(v.state, "in-flight", "a cancelled run inside the grace is not yet a finding");
}
{
  // A FAILED run on main is already paged by deploy-alert.yml. It is still reported,
  // so a reader of the tick line sees it, and it does not page twice.
  const v = judgeDeployedTip({
    servedCommit: PREV.slice(0, 12),
    newestMainRun: run({ conclusion: "failure" }),
    nowMs: NOW,
  });
  eq(v.state, "not-live", "a failed run leaves main not live, and that is recorded");
  assert(v.state === "not-live" && v.reason === "failed", "named as failed");
  assert(!deployStatePages(v), "and does NOT page here, because deploy-alert.yml already does");
}
{
  // The neighbouring hole nothing covers: the run reported success and the commit
  // still is not being served, which is a skipped or ineffective deploy job.
  const v = judgeDeployedTip({
    servedCommit: PREV.slice(0, 12),
    newestMainRun: run({ conclusion: "success" }),
    nowMs: NOW,
  });
  assert(v.state === "not-live" && v.reason === "succeeded", "a successful run not being served is its own finding");
  assert(deployStatePages(v), "and pages, since deploy-alert fires only on failure");
}
{
  const v = judgeDeployedTip({ servedCommit: "dev", newestMainRun: run(), nowMs: NOW });
  eq(v.state, "unmeasured", "a build with no commit stamp measures nothing");
  assert(!deployStatePages(v), "and never pages off it");
}
{
  const v = judgeDeployedTip({ servedCommit: TIP.slice(0, 12), newestMainRun: null, nowMs: NOW });
  eq(v.state, "unmeasured", "no readable run on main measures nothing either");
}
{
  // An unreadable start time cannot say how long the tip has been undeployed, and a
  // NaN comparison would land on the permissive side with nothing said (L: parseStampMs).
  const v = judgeDeployedTip({
    servedCommit: PREV.slice(0, 12),
    newestMainRun: run({ conclusion: "cancelled", createdAtMs: null }),
    nowMs: NOW,
  });
  eq(v.state, "unmeasured", "an unreadable run start is unmeasured, not a finding and not a pass");
}

// --- telling a refusal from a failure ------------------------------------------
{
  const refused: WorkflowJobSummary[] = [
    { name: "typecheck", conclusion: "failure", stepCount: 0 },
    { name: "lint", conclusion: "failure", stepCount: 0 },
  ];
  eq(classifyFailedRun(refused), "never-started", "every failed job with zero steps never started");
}
{
  const ran: WorkflowJobSummary[] = [
    { name: "typecheck", conclusion: "success", stepCount: 6 },
    { name: "lint", conclusion: "failure", stepCount: 5 },
  ];
  eq(classifyFailedRun(ran), "ran-and-failed", "a job that executed steps really failed");
}
{
  // The mixed case, which is the one a naive "any zero step job" rule gets wrong: a
  // real failure alongside a job that was never allocated still means the run RAN,
  // and reporting it as refused would tell somebody to go and look at billing.
  const mixed: WorkflowJobSummary[] = [
    { name: "lint", conclusion: "failure", stepCount: 4 },
    { name: "vitest", conclusion: "failure", stepCount: 0 },
  ];
  eq(classifyFailedRun(mixed), "ran-and-failed", "one job that ran is enough to say the run ran");
}
{
  eq(classifyFailedRun([]), "unreadable", "no jobs at all says nothing either way");
  eq(
    classifyFailedRun([{ name: "a", conclusion: "success", stepCount: 3 }]),
    "unreadable",
    "a run reported failed whose jobs all succeeded is a payload this does not understand",
  );
}

// --- judgeCiStart --------------------------------------------------------------
{
  let jobsAsked = 0;
  const v = await judgeCiStart({
    runs: [run({ conclusion: "success" })],
    readJobs: async () => {
      jobsAsked++;
      return [];
    },
  });
  eq(v.state, "starting", "a successful run is proof jobs start");
  eq(jobsAsked, 0, "and a healthy repo spends no extra request asking about jobs");
}
{
  let jobsAsked = 0;
  const v = await judgeCiStart({
    runs: [run({ id: 7, conclusion: "failure", name: "CI" })],
    readJobs: async (id) => {
      jobsAsked++;
      eq(id, 7, "the jobs of the run it judged, not another one");
      return [{ name: "typecheck", conclusion: "failure", stepCount: 0 }];
    },
  });
  eq(v.state, "refused", "a failed run whose jobs executed nothing is a refusal");
  eq(jobsAsked, 1, "and it asked exactly once");
}
{
  const v = await judgeCiStart({
    runs: [run({ conclusion: "failure" })],
    readJobs: async () => [{ name: "lint", conclusion: "failure", stepCount: 9 }],
  });
  eq(v.state, "starting", "a failed run whose jobs ran is not a refusal");
}
{
  const v = await judgeCiStart({
    runs: [run({ conclusion: "failure" })],
    readJobs: async () => null,
  });
  eq(v.state, "unmeasured", "an unreadable jobs list measures nothing");
}
{
  const v = await judgeCiStart({
    runs: [run({ status: "in_progress", conclusion: null })],
    readJobs: async () => [],
  });
  eq(v.state, "unmeasured", "with nothing completed to look at, nothing is judged");
}
{
  // A run that is NOT on main is still the right subject: the 2026-09-10 refusal was
  // on a pull request, and a check scoped to main would have been blind to it.
  const v = await judgeCiStart({
    runs: [run({ id: 9, branch: "fix/whatever", event: "pull_request", conclusion: "failure" })],
    readJobs: async () => [{ name: "build", conclusion: "failure", stepCount: 0 }],
  });
  eq(v.state, "refused", "a refusal on a pull request is seen");
}

// --- parsing GitHub's payloads -------------------------------------------------
{
  const parsed = parseWorkflowRuns({
    workflow_runs: [
      {
        id: 3,
        name: "CI",
        head_sha: TIP,
        event: "push",
        head_branch: "main",
        status: "completed",
        conclusion: "cancelled",
        created_at: "2026-09-16T10:00:00Z",
        html_url: "https://example.test/3",
      },
      // Dropped: no sha. A run with an empty sha compares unequal to every commit,
      // so keeping it would read as main never being live.
      { id: 4, head_sha: "", html_url: "https://example.test/4" },
    ],
  });
  eq(parsed.length, 1, "a row with no sha is dropped rather than defaulted");
  eq(parsed[0]!.conclusion, "cancelled", "and the readable row keeps its conclusion");
  eq(parsed[0]!.createdAtMs, Date.UTC(2026, 8, 16, 10, 0, 0), "and its start time");
}
{
  eq(parseWorkflowRuns({}).length, 0, "a payload with no runs parses to nothing");
  eq(parseWorkflowRuns(null).length, 0, "and so does no payload at all");
  const jobs = parseWorkflowJobs({
    jobs: [{ name: "typecheck", conclusion: "failure", steps: [] }, { name: "lint", conclusion: "failure" }],
  });
  eq(jobs.length, 2, "both jobs parse");
  eq(jobs[1]!.stepCount, 0, "a job with no steps array counts zero, which is the signal");
}

// --- the whole check, wired -----------------------------------------------------
interface Sent {
  key: string;
  text: string;
}

function harness(over: Partial<Parameters<typeof runCiHealthCheck>[0]> = {}) {
  const alerts: Sent[] = [];
  const resolved: Sent[] = [];
  const deps = {
    nowMs: NOW,
    servedCommit: PREV.slice(0, 12),
    token: "t",
    readRuns: async () => [run({ conclusion: "cancelled" })],
    readJobs: async () => [],
    // #3648: main's tip, read from the branch rather than inferred from the newest run.
    readMainTip: async () => ({ sha: TIP, committedAtMs: NOW - 60 * 60_000 }),
    // The targeted read of the tip's own run, for when the listing does not hold it.
    // Unreadable by default, so a case that needs it says what it answers.
    readTipRuns: async () => null,
    cooldownMs: { deploy: 1, refusal: 1 },
    notify: async (key: string, _ms: number, text: string) => {
      alerts.push({ key, text });
    },
    resolve: async (key: string, text: string) => {
      resolved.push({ key, text });
    },
    ...over,
  } as Parameters<typeof runCiHealthCheck>[0];
  return { deps, alerts, resolved };
}

{
  const h = harness();
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "not-live", "the wired check reaches the finding");
  eq(h.alerts.length, 1, "and pages once");
  eq(h.alerts[0]!.key, DEPLOY_ALERT_KEY, "on the deploy key");
  assert(
    h.alerts[0]!.text.includes(PREV.slice(0, 12)) && h.alerts[0]!.text.includes(TIP.slice(0, 12)),
    "naming BOTH the commit being served and the one that is not, so the reader can tell which is which",
  );
  assert(
    h.alerts[0]!.text.includes("actions/runs/1"),
    "and linking the run, since the remedy is on it",
  );
  assert(
    !h.resolved.some((r) => r.key === DEPLOY_ALERT_KEY),
    "and clears nothing on that key while the finding stands",
  );
}
{
  const h = harness({ servedCommit: TIP.slice(0, 12), readRuns: async () => [run()] });
  await runCiHealthCheck(h.deps);
  eq(h.alerts.length, 0, "a live deployment pages nothing");
  assert(
    h.resolved.some((r) => r.key === DEPLOY_ALERT_KEY),
    "and says so, because a condition somebody was paged about has to be able to end",
  );
}
{
  // The rule every all clear in this repo is judged by: a run that measured nothing
  // clears nothing (#1134, #1152).
  const h = harness({ readRuns: async () => null });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "not-measured", "an unreadable listing measures nothing");
  eq(h.alerts.length, 0, "pages nothing");
  eq(h.resolved.length, 0, "and clears nothing");
}
{
  const h = harness({
    readRuns: async () => {
      throw new Error("network");
    },
  });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "not-measured", "a throwing listing is contained, not propagated onto the lane");
  eq(h.alerts.length + h.resolved.length, 0, "and says nothing off it");
}
{
  const h = harness({ token: "" });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "not-measured", "no token is a quiet no-op, like the canary gap filler");
  eq(h.alerts.length + h.resolved.length, 0, "with nothing said");
}
{
  const h = harness({
    servedCommit: TIP.slice(0, 12),
    readRuns: async () => [run({ id: 5, conclusion: "failure", headSha: TIP })],
    readJobs: async () => [{ name: "lint", conclusion: "failure", stepCount: 0 }],
  });
  await runCiHealthCheck(h.deps);
  const refusal = h.alerts.find((a) => a.key === REFUSAL_ALERT_KEY);
  assert(refusal !== undefined, "a refused run pages on its own key");
  assert(
    /never|refused/i.test(refusal!.text) && /annotation/i.test(refusal!.text),
    `and tells the reader where the evidence is (got ${refusal!.text})`,
  );
  assert(
    /push guard|watching main/i.test(refusal!.text),
    "and says what is unwatched while it lasts, which is the part nobody would work out",
  );
}
{
  const h = harness({
    servedCommit: TIP.slice(0, 12),
    readRuns: async () => [run({ conclusion: "failure", headSha: TIP })],
    readJobs: async () => [{ name: "lint", conclusion: "failure", stepCount: 7 }],
  });
  await runCiHealthCheck(h.deps);
  assert(
    !h.alerts.some((a) => a.key === REFUSAL_ALERT_KEY),
    "an ordinary red run does NOT page as a refusal",
  );
  assert(
    h.resolved.some((r) => r.key === REFUSAL_ALERT_KEY),
    "and is a measured healthy reading for the refusal condition, so it can clear",
  );
}

// --- the copy -------------------------------------------------------------------
{
  const text = formatDeployNotLiveAlert({
    reason: "cancelled",
    tipSha: TIP,
    servedCommit: PREV.slice(0, 12),
    behindMs: 125 * 60_000,
    runUrl: "https://example.test/9",
  });
  assert(!/^Slate/.test(text), "the alert does not open with the word Slate, which Slack already says");
  assert(/2 hours/.test(text), "and says how long in hours once it is past two");
  assert(
    /Re-run the deploy job|empty commit/.test(text),
    "and names an action that changes the state the reader is in",
  );
  assert(!/undefined|NaN|\[object/.test(text), "and leaks nothing");
}
{
  const succeeded = formatDeployNotLiveAlert({
    reason: "succeeded",
    tipSha: TIP,
    servedCommit: PREV.slice(0, 12),
    behindMs: 45 * 60_000,
    runUrl: "https://example.test/9",
  });
  const cancelled = formatDeployNotLiveAlert({
    reason: "cancelled",
    tipSha: TIP,
    servedCommit: PREV.slice(0, 12),
    behindMs: 45 * 60_000,
    runUrl: "https://example.test/9",
  });
  assert(
    succeeded !== cancelled,
    "two different causes give two different instructions, rather than one message answering for both (L11)",
  );
  assert(/45 minutes/.test(cancelled), "and minutes are said as minutes under two hours");
}
{
  const text = formatCiRefusedAlert({ runName: "CI", runUrl: "https://example.test/1" });
  assert(!/^Slate/.test(text), "the refusal alert does not open with the word Slate either");
  assert(!/undefined|NaN|\[object/.test(text), "and leaks nothing");
}

// --- the deploy comparison reads the DEPLOYING workflow's run ---------------------
//
// `main-push-guard.yml` fires on every push to main too, so "the newest push run on
// main" is routinely its run, and its conclusion says nothing about whether the
// deploy happened. A guard run that succeeded beside a cancelled deploy would read
// as main having shipped, which is the exact false pass this check exists to stop
// (L63).
{
  const h = harness({
    servedCommit: PREV.slice(0, 12),
    readRuns: async () => [
      // Newest, and the WRONG run to judge on: it succeeded, and it never deploys.
      run({
        id: 20,
        name: "Main push guard",
        path: ".github/workflows/main-push-guard.yml",
        conclusion: "success",
      }),
      run({ id: 21, conclusion: "cancelled" }),
    ],
  });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "not-live", "the cancelled deploy run is what decides, not the guard run beside it");
  eq(res.deployReason, "cancelled", "and it is named as cancelled");
  assert(
    h.alerts.some((a) => a.key === DEPLOY_ALERT_KEY && a.text.includes("actions/runs/21")),
    "and the alert links the deploying run",
  );
}
{
  // The other direction: with no run of the deploying workflow to read, the check
  // measures nothing rather than judging on whatever push run happens to be newest.
  const h = harness({
    servedCommit: PREV.slice(0, 12),
    readRuns: async () => [
      run({ id: 22, path: ".github/workflows/main-push-guard.yml", conclusion: "cancelled" }),
    ],
  });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "unmeasured", "no run of the deploying workflow measures nothing");
  assert(
    !h.alerts.some((a) => a.key === DEPLOY_ALERT_KEY),
    "and pages nothing off a workflow that does not deploy",
  );
}
{
  // The named path is a claim about the repo, so it is checked against the repo. A
  // rename or a moved deploy job would otherwise leave this check finding no run and
  // going permanently, silently unmeasured (L98).
  const ci = readFileSync(join(repoRoot, DEPLOY_WORKFLOW_PATH), "utf8");
  assert(
    /^\s{2}deploy:/m.test(ci),
    `${DEPLOY_WORKFLOW_PATH} still holds the deploy job this check judges on`,
  );
  assert(
    /github\.ref == 'refs\/heads\/main'/.test(ci),
    "and that job is still the one gated on a push to main",
  );
  assert(
    /cf:deploy/.test(ci),
    "and it is still what ships the Worker, rather than a job that only shares the name",
  );
}

// --- parsing keeps the workflow path ---------------------------------------------
{
  const parsed = parseWorkflowRuns({
    workflow_runs: [
      {
        id: 3,
        name: "CI",
        path: ".github/workflows/ci.yml",
        head_sha: TIP,
        event: "push",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        created_at: "2026-09-16T10:00:00Z",
        html_url: "https://example.test/3",
      },
    ],
  });
  eq(parsed[0]!.path, ".github/workflows/ci.yml", "the workflow file survives parsing");
}

// --- #3648 (L760): live is judged against main's ACTUAL tip -------------------------
//
// The check used to take main's tip to be whatever commit the newest deploying run on
// main was for. A merge whose run GitHub never created (an Actions incident dropping
// push events) leaves the PREVIOUS merge's run newest, and that run's commit is the one
// being served, so the check read "live" and cleared the page: a merged fix not
// running, with this check saying it was. The expected commit now comes from the
// branch, and only that commit's own run can explain why it is not live.
{
  // The defect: the tip's run never registered. The newest deploying run is the
  // previous merge's, which is exactly what is being served.
  const h = harness({
    servedCommit: PREV.slice(0, 12),
    readRuns: async () => [run({ id: 30, headSha: PREV, conclusion: "success" })],
    readMainTip: async () => ({ sha: TIP, committedAtMs: NOW - 60 * 60_000 }),
    readTipRuns: async () => [],
  });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "not-live", "a tip with no run, past the grace, is not live, whatever the previous run says");
  eq(res.deployReason, "no-run", "and is named as having no run");
  const page = h.alerts.find((a) => a.key === DEPLOY_ALERT_KEY);
  assert(page !== undefined, "it pages, because no workflow ran to report anything");
  assert(
    page !== undefined && page.text.includes(TIP.slice(0, 12)) && page.text.includes(PREV.slice(0, 12)),
    "naming the tip and the commit being served",
  );
  assert(
    page !== undefined && page.text.includes(`/commit/${TIP}`) && !page.text.includes("actions/runs/30"),
    "and linking the commit, never the previous merge's run, which says nothing about this one",
  );
  assert(!h.resolved.some((r) => r.key === DEPLOY_ALERT_KEY), "and it does NOT announce main as live");
}
{
  // The control: a merge seconds old whose run has not registered yet is every merge.
  const h = harness({
    servedCommit: PREV.slice(0, 12),
    readRuns: async () => [run({ id: 31, headSha: PREV, conclusion: "success" })],
    readMainTip: async () => ({ sha: TIP, committedAtMs: NOW - 2 * 60_000 }),
    readTipRuns: async () => [],
  });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "in-flight", "a tip inside the grace with no run yet is in flight");
  eq(h.alerts.filter((a) => a.key === DEPLOY_ALERT_KEY).length, 0, "and pages nothing");
  assert(!h.resolved.some((r) => r.key === DEPLOY_ALERT_KEY), "and clears nothing: the tip is not live yet");
}
{
  // The tip's run fell out of the listing (a busy day of pull request runs) but exists:
  // the targeted read finds it, and its own ending decides.
  const h = harness({
    servedCommit: PREV.slice(0, 12),
    readRuns: async () => [run({ id: 32, headSha: PREV, conclusion: "success" })],
    readMainTip: async () => ({ sha: TIP, committedAtMs: NOW - 60 * 60_000 }),
    readTipRuns: async () => [run({ id: 33, headSha: TIP, conclusion: "cancelled" })],
  });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deployReason, "cancelled", "the tip's own run, read directly, names the ending");
  assert(
    h.alerts.some((a) => a.key === DEPLOY_ALERT_KEY && a.text.includes("actions/runs/33")),
    "and the page links that run",
  );
}
{
  // An unreadable targeted read is not an absent run (L215): nothing is said.
  const h = harness({
    servedCommit: PREV.slice(0, 12),
    readRuns: async () => [run({ id: 34, headSha: PREV, conclusion: "success" })],
    readMainTip: async () => ({ sha: TIP, committedAtMs: NOW - 60 * 60_000 }),
    readTipRuns: async () => null,
  });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "unmeasured", "a tip run that could not be looked up measures nothing");
  eq(h.alerts.filter((a) => a.key === DEPLOY_ALERT_KEY).length + h.resolved.filter((r) => r.key === DEPLOY_ALERT_KEY).length, 0, "and says nothing either way");
}
{
  // An unreadable tip is unmeasured, even when the served commit matches the newest
  // run: that match is the very reading this change stops trusting on its own.
  const h = harness({
    servedCommit: PREV.slice(0, 12),
    readRuns: async () => [run({ id: 35, headSha: PREV, conclusion: "success" })],
    readMainTip: async () => null,
  });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "unmeasured", "without main's tip, nothing is measured");
  assert(!h.resolved.some((r) => r.key === DEPLOY_ALERT_KEY), "and nothing is cleared");
}
{
  const h = harness({
    readMainTip: async () => {
      throw new Error("network");
    },
  });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "unmeasured", "a throwing tip read is contained, not propagated onto the lane");
}
{
  // Serving the tip is live, whether or not its run is in the listing.
  const h = harness({
    servedCommit: TIP.slice(0, 12),
    readRuns: async () => [run({ id: 36, headSha: PREV, conclusion: "success" })],
    readMainTip: async () => ({ sha: TIP, committedAtMs: NOW - 60 * 60_000 }),
  });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "live", "the served commit IS main's tip");
  assert(h.resolved.some((r) => r.key === DEPLOY_ALERT_KEY), "and that clears the page");
}
{
  const text = formatDeployNotLiveAlert({
    reason: "no-run",
    tipSha: TIP,
    servedCommit: PREV.slice(0, 12),
    behindMs: 50 * 60_000,
    runUrl: null,
  });
  assert(/no CI run|never started a CI run/i.test(text), `the no run page says no run exists (got ${text})`);
  assert(/githubstatus|Actions incident/i.test(text), "and sends the reader to the likely cause");
  assert(text.includes(`https://github.com/Try-Pennie/slate/commit/${TIP}`), "and links the commit, since there is no run to link");
  assert(!/undefined|NaN|\[object|null/.test(text), "and leaks nothing");
}
{
  // The tip read parses GitHub's commit payload, and refuses one it cannot read.
  eq(
    JSON.stringify(parseMainTip({ sha: TIP, commit: { committer: { date: "2026-09-16T10:00:00Z" } } })),
    JSON.stringify({ sha: TIP, committedAtMs: Date.UTC(2026, 8, 16, 10, 0, 0) }),
    "a commit payload gives the sha and when it landed",
  );
  eq(parseMainTip({ sha: "", commit: {} }), null, "a payload with no sha is unreadable, never an empty tip");
  eq(parseMainTip(null), null, "and so is no payload");
  eq(
    JSON.stringify(parseMainTip({ sha: TIP, commit: {} })),
    JSON.stringify({ sha: TIP, committedAtMs: null }),
    "a missing date keeps the sha and says the time is unknown",
  );
}
{
  // An unreadable landing time cannot say whether the grace has passed (L50).
  const h = harness({
    servedCommit: PREV.slice(0, 12),
    readRuns: async () => [run({ id: 37, headSha: PREV, conclusion: "success" })],
    readMainTip: async () => ({ sha: TIP, committedAtMs: null }),
    readTipRuns: async () => [],
  });
  const res = await runCiHealthCheck(h.deps);
  eq(res.deploy, "unmeasured", "a tip with no run and an unreadable landing time is unmeasured, not paged");
}

finish();

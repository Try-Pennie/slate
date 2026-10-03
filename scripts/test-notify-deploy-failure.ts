// #122: unit-tests the deploy-failure Slack alerter's pure core.
//
// - buildDeployFailureMessage produces plain, dash-free, emoji-free copy that
//   names the branch, links the failed run, and cites the commit and actor.
// - run() posts exactly once through the injected poster, honours
//   SLACK_ALERTS_CHANNEL, and FAILS LOUD (ok:false) when the post errors or Slack
//   is unconfigured, so a broken or unset alerter goes visibly red in Actions
//   rather than silently pretending it warned anyone.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/test-notify-deploy-failure.ts
import {
  buildDeployFailureMessage,
  readContextFromEnv,
  run,
  type DeployFailureContext,
} from "./notify-deploy-failure.ts";
import { assert, finish } from "./lib/harness.ts";
import {
  assertAlerterFailsLoud,
  assertHouseStyle,
  FAIL_LOUD_CHECKS,
  HOUSE_STYLE_CHECKS,
} from "./lib/alerter-contract.ts";

const ctx: DeployFailureContext = {
  workflowName: "CI",
  branch: "main",
  runUrl: "https://github.com/Try-Pennie/slate/actions/runs/123",
  commitSha: "abc1234def5678",
  actor: "dwright-pennie",
};

// --- message builder ---
const text = buildDeployFailureMessage(ctx);
assert(text.includes("main"), "message names the branch");
assert(text.includes(ctx.runUrl), "message links to the failed run");
assert(text.includes("abc1234"), "message includes the short commit sha");
assert(text.includes("dwright-pennie"), "message names the actor");
assert(/deploy failed/i.test(text), "message says the deploy failed");
// House style: no dashes as punctuation, no emoji (Slack shortcodes included).
// The count is pinned so a helper that stopped asserting cannot read as a pass.
assert(
  assertHouseStyle(assert, text, "message") === HOUSE_STYLE_CHECKS,
  "the shared house-style check ran every one of its assertions",
);

// --- #3087: the copy says WHICH job failed, because the remedies differ ---
// A red security scan on main fails the CI run without holding back the deploy, so
// "deploy failed, the live site may not have updated" would send the reader to the
// wrong problem while the commit the scan objected to is already live (L11).
{
  const scan = buildDeployFailureMessage({ ...ctx, failedJobs: ["security-scan-main"] });
  assert(/security scan/i.test(scan), "a scan-only failure says the security scan failed");
  assert(!/deploy failed/i.test(scan), "and does NOT say the deploy failed");
  assert(/live/i.test(scan) && /rotate/i.test(scan), "it says the commit is live and to rotate anything found");
  assert(scan.includes(ctx.runUrl) && scan.includes("abc1234"), "and still links the run and names the commit");
  assert(
    assertHouseStyle(assert, scan, "scan message") === HOUSE_STYLE_CHECKS,
    "the scan message passes the house style too",
  );

  const both = buildDeployFailureMessage({ ...ctx, failedJobs: ["deploy", "security-scan-main"] });
  assert(/deploy failed/i.test(both), "a failed deploy alongside the scan still leads with the deploy");
  assert(/deploy, security-scan-main/.test(both), "and names every failed job");

  const unknown = buildDeployFailureMessage({ ...ctx, failedJobs: null });
  assert(unknown === text, "when the jobs could not be read the message is the generic one, claiming nothing more");
  const none = buildDeployFailureMessage({ ...ctx, failedJobs: [] });
  assert(none === text, "and an empty list is read the same way, not as a scan failure");

  const env = readContextFromEnv({ FAILED_JOBS: "deploy,vitest (2)" });
  assert(
    JSON.stringify(env.failedJobs) === JSON.stringify(["deploy", "vitest (2)"]),
    "FAILED_JOBS is split on commas, keeping a matrix job's name whole",
  );
  assert(readContextFromEnv({}).failedJobs === null, "an absent FAILED_JOBS is unknown, not empty");
  assert(readContextFromEnv({ FAILED_JOBS: "unknown" }).failedJobs === null, "as is the workflow's own unknown marker");
}

// --- env reader maps every field ---
const parsed = readContextFromEnv({
  WORKFLOW_NAME: "CI",
  BRANCH: "main",
  RUN_URL: "https://x/runs/9",
  COMMIT_SHA: "deadbeef",
  ACTOR: "octocat",
});
assert(
  parsed.workflowName === "CI" &&
    parsed.branch === "main" &&
    parsed.runUrl === "https://x/runs/9" &&
    parsed.commitSha === "deadbeef" &&
    parsed.actor === "octocat",
  "readContextFromEnv maps all fields",
);

const baseEnv = {
  WORKFLOW_NAME: "CI",
  BRANCH: "main",
  RUN_URL: "https://x/runs/1",
  COMMIT_SHA: "abc1234",
  ACTOR: "octo",
};

// --- run(): the fail-loud contract, shared with the smoke alerter (#1596) ---
// Deploy is unconfigured by having no SLACK_BOT_TOKEN.
{
  const ran = await assertAlerterFailsLoud(assert, {
    channel: "C123",
    configured: (post) =>
      run(post, { ...baseEnv, SLACK_BOT_TOKEN: "xoxb-test", SLACK_ALERTS_CHANNEL: "C123" }),
    unconfigured: (post) => run(post, baseEnv),
  });
  assert(ran === FAIL_LOUD_CHECKS, "the shared fail-loud contract ran every one of its assertions");
}

finish();

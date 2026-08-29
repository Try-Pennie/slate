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

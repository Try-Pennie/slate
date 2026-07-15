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
assert(
  !new RegExp("[\u2014\u2013]").test(text),
  "message has no em or en dashes",
);
assert(
  !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text),
  "message has no unicode emoji",
);
assert(!/:[a-z0-9_]+:/.test(text), "message has no slack emoji shortcodes");

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

// --- run(): happy path posts once to the configured channel ---
{
  const calls: { text: string; channel?: string }[] = [];
  const post = async (m: { text: string; channel?: string }) => {
    calls.push(m);
    return { ok: true };
  };
  const res = await run(post, {
    ...baseEnv,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_ALERTS_CHANNEL: "C123",
  });
  assert(res.ok, "run returns ok on a successful post");
  assert(calls.length === 1, "run posts exactly once");
  assert(calls[0]?.channel === "C123", "run posts to SLACK_ALERTS_CHANNEL");
}

// --- run(): a Slack API error FAILS LOUD ---
{
  let called = 0;
  const post = async () => {
    called++;
    return { ok: false, error: "channel_not_found" };
  };
  const res = await run(post, {
    ...baseEnv,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_ALERTS_CHANNEL: "C123",
  });
  assert(!res.ok, "run FAILS LOUD when the Slack post errors");
  assert(/channel_not_found/.test(res.reason), "run surfaces the Slack error");
  assert(called === 1, "run attempted the post once");
}

// --- run(): unconfigured Slack FAILS LOUD (never silently no-ops) ---
{
  const post = async () => ({ ok: false, error: "slack-not-configured" });
  const res = await run(post, baseEnv); // no SLACK_BOT_TOKEN / channel
  assert(!res.ok, "run FAILS LOUD when Slack is unconfigured");
  assert(
    /slack-not-configured/.test(res.reason),
    "run surfaces the unconfigured reason",
  );
}

finish();

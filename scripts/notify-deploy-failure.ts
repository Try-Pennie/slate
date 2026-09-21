// #122: post a Slack alert when a CI run fails on a push to main, so a silently
// non-updating live site (a billing freeze, a transient Cloudflare error) is
// noticed instead of discovered by accident. Invoked by
// .github/workflows/deploy-alert.yml on a failed CI workflow_run.
//
// Fails loud: a Slack post that errors, or Slack being unconfigured, exits
// non-zero so the alert job goes visibly red in Actions rather than pretending
// it warned anyone.
//
// #1598: it posts through the dependency free poster (scripts/lib/slack-post.ts),
// not through the app's notifier. That import chain was
// postSlack -> defaultAlertsChannel -> supabaseAdmin -> @supabase/supabase-js, which
// is why the workflow carried pnpm/action-setup, setup-node with the pnpm cache and a
// full `pnpm install --frozen-lockfile` to send one message. This alert fires exactly
// when CI on main has already failed, which correlates with GitHub or the network
// having a bad day, so every dependency it carried was another way for it to be
// unavailable in the conditions it exists for. #1524 made the same removal for the
// main push guard after a 429 downloading pnpm/action-setup left that guard unrun.
// Only the HTTP call is local: the wording still lives in one place here, so no copy
// is duplicated anywhere (L41). scripts/test-dependency-free-scripts.ts walks this
// file's transitive imports and fails on any edge that leaves scripts/.
import { runAlerter } from "./lib/run-alerter.ts";

export interface DeployFailureContext {
  workflowName: string;
  branch: string;
  runUrl: string;
  commitSha: string;
  actor: string;
}

/** Injectable poster so the core is testable with a hand-written fake. */
export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

export function buildDeployFailureMessage(ctx: DeployFailureContext): string {
  const shortSha = ctx.commitSha ? ctx.commitSha.slice(0, 7) : "unknown";
  const workflow = ctx.workflowName || "CI";
  const branch = ctx.branch || "main";
  return [
    `Slate deploy failed on ${branch}.`,
    `The "${workflow}" workflow did not finish, so the live site may not have updated.`,
    `Commit ${shortSha} by ${ctx.actor || "unknown"}.`,
    ctx.runUrl,
  ].join("\n");
}

export function readContextFromEnv(
  env: Record<string, string | undefined>,
): DeployFailureContext {
  return {
    workflowName: env.WORKFLOW_NAME ?? "",
    branch: env.BRANCH ?? "",
    runUrl: env.RUN_URL ?? "",
    commitSha: env.COMMIT_SHA ?? "",
    actor: env.ACTOR ?? "",
  };
}

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; reason: string }> {
  const text = buildDeployFailureMessage(readContextFromEnv(env));
  // The channel comes from the workflow, never from a database lookup: reaching the
  // tunable channel (#571) is what made this alert need an install. An empty value is
  // refused by name (slack-channel-not-configured) rather than posted into nowhere,
  // because an unset repo variable interpolates to the empty string (#1500).
  const channel = env.SLACK_ALERTS_CHANNEL?.trim() || undefined;
  const res = await post({ text, ...(channel ? { channel } : {}) });
  return res.ok
    ? { ok: true, reason: "posted" }
    : { ok: false, reason: res.error ?? "unknown-error" };
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env);
  if (!res.ok) {
    console.error(
      `::error title=Deploy-failure alert not sent::Could not post the Slack deploy-failure alert (${res.reason}). Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo Actions settings.`,
    );
    return 1;
  }
  console.log("Posted deploy-failure alert to Slack.");
  return 0;
});

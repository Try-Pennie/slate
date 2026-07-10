// #122: post a Slack alert when a CI run fails on a push to main, so a silently
// non-updating live site (a billing freeze, a transient Cloudflare error) is
// noticed instead of discovered by accident. Invoked by
// .github/workflows/deploy-alert.yml on a failed CI workflow_run. Reuses the
// app's Slack notifier (src/lib/notify/slack.ts) instead of a second Slack
// implementation.
//
// Fails loud: a Slack post that errors, or Slack being unconfigured, exits
// non-zero so the alert job goes visibly red in Actions rather than pretending
// it warned anyone.
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { postSlack } from "@/lib/notify/slack";

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
  // Pass the channel explicitly so the notifier does not need the app's Supabase
  // config in CI; an empty value lets postSlack report "no-channel" (fail loud).
  const channel = env.SLACK_ALERTS_CHANNEL?.trim() || undefined;
  const res = await post({ text, ...(channel ? { channel } : {}) });
  return res.ok
    ? { ok: true, reason: "posted" }
    : { ok: false, reason: res.error ?? "unknown-error" };
}

const isMain =
  !!process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  run(postSlack, process.env).then((res) => {
    if (!res.ok) {
      console.error(
        `::error title=Deploy-failure alert not sent::Could not post the Slack deploy-failure alert (${res.reason}). Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo Actions settings.`,
      );
      process.exit(1);
    }
    console.log("Posted deploy-failure alert to Slack.");
    process.exit(0);
  });
}

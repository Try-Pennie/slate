// Post a Slack alert when the nightly real database run fails (#3099).
//
// Invoked by .github/workflows/db-replay.yml on the SCHEDULED run only. On a pull
// request the red check is the signal and the author is looking at it; at night
// nobody is, and a migration that stopped replaying from empty, or a suite that
// stopped running, would otherwise sit in the Actions tab until the next time
// somebody needed a fresh database and found it could not be built.
//
// Bare node, no dependency install and no alias hook, like its siblings: the
// workflow installs nothing, and scripts/test-dependency-free-scripts.ts holds this
// to importing nothing outside scripts/ (#1598).
//
// Fails loud: a Slack post that errors, or Slack being unconfigured, exits non-zero
// so the alert step goes visibly red rather than pretending it warned anyone.
import { runAlerter } from "./lib/run-alerter.ts";
import { postToAlertsChannel } from "./lib/slack-post.ts";

export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

export interface DbReplayFailureContext {
  runUrl: string;
}

export function readContextFromEnv(env: Record<string, string | undefined>): DbReplayFailureContext {
  return { runUrl: env.RUN_URL ?? "" };
}

/**
 * One place for the wording, so the workflow holds no copy of its own (L41).
 *
 * It does not guess which suite failed or why. The run names the suite and the
 * migration it stopped at, and a message here naming a cause it did not measure
 * would send somebody after the wrong one (L11).
 */
export function buildDbReplayFailureMessage(ctx: DbReplayFailureContext): string {
  const lines = [
    "The nightly real database run did not pass, so nothing has shown tonight that the migrations still build a working database from empty.",
    "Either a migration no longer applies to an empty database, a row level security or grant check failed, a real database suite failed, Docker was not available on the runner, or the run was cancelled (usually by its time limit). The run names which.",
  ];
  // An absent RUN_URL is an unset workflow variable, not a link to nowhere.
  lines.push(ctx.runUrl.trim() || "Open the DB replay workflow in the Actions tab.");
  return lines.join("\n");
}

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; reason: string }> {
  return postToAlertsChannel(post, buildDbReplayFailureMessage(readContextFromEnv(env)), env);
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env);
  if (!res.ok) {
    console.error(
      `::error title=DB replay alert not sent::Could not post the Slack alert for the failed nightly database run (${res.reason}). Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo Actions settings.`,
    );
    return 1;
  }
  console.log("Posted the DB replay failure alert to Slack.");
  return 0;
});

// Post a Slack alert when the daily cal.com parity sweep could not report (#2031).
//
// Invoked by .github/workflows/schedule-parity.yml when a step fails. Note what this
// does NOT cover: the drift itself. That is reported by Slate, through the app's own
// alerting, because a condition needs a cooldown and an all clear and a runner has
// no memory. This speaks about the other failure, the sweep that could not read
// cal.com or could not reach Slate to tell it, which would otherwise sit non-zero in
// the Actions tab and only surface thirty hours later as a stale heartbeat.
//
// Bare node, no dependency install and no alias hook, like its two siblings: this is
// the step that has to still work when something has already gone wrong, and every
// dependency it carries is another way for it to be unavailable exactly then (#1598).
//
// Fails loud: a Slack post that errors, or Slack being unconfigured, exits non-zero
// so the alert job goes visibly red rather than pretending it warned anyone.
import { runAlerter } from "./lib/run-alerter.ts";

export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

export interface ParityFailureContext {
  runUrl: string;
}

export function readContextFromEnv(env: Record<string, string | undefined>): ParityFailureContext {
  return { runUrl: env.RUN_URL ?? "" };
}

/**
 * One place for the wording, so the workflow holds no copy of its own (L41).
 *
 * It deliberately does NOT guess which of the failures happened. The step that
 * failed already exits on its own code with its own sentence, and a message here
 * naming a cause it did not measure would send somebody after the wrong one (L11).
 */
export function buildParityFailureMessage(ctx: ParityFailureContext): string {
  const lines = [
    "The daily Slate against cal.com comparison did not complete, so nothing checked whether the two systems still agree today.",
    "It reads roughly one cal.com schedule per agent and then reports the result to Slate. A rate limit, a refused key or an unreachable deployment each stop it, and the run says which.",
  ];
  // An absent RUN_URL is an unset workflow variable, not a link to nowhere: saying
  // where to look beats printing an empty line under the sentence.
  lines.push(ctx.runUrl.trim() || "Open the schedule-parity workflow in the Actions tab.");
  return lines.join("\n");
}

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; reason: string }> {
  const text = buildParityFailureMessage(readContextFromEnv(env));
  // The channel comes from the workflow, never from a database lookup (#1598). An
  // empty value is refused by name rather than posted into nowhere, because an unset
  // repo variable interpolates to the empty string.
  const channel = env.SLACK_ALERTS_CHANNEL?.trim() || undefined;
  const res = await post({ text, ...(channel ? { channel } : {}) });
  return res.ok ? { ok: true, reason: "posted" } : { ok: false, reason: res.error ?? "unknown-error" };
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env);
  if (!res.ok) {
    console.error(
      `::error title=Parity alert not sent::Could not post the Slack parity-failure alert (${res.reason}). Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo Actions settings.`,
    );
    return 1;
  }
  console.log("Posted parity-failure alert to Slack.");
  return 0;
});

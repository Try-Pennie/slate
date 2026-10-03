// Speak about a rollback that did not end cleanly (#3094).
//
// Invoked by .github/workflows/rollback.yml only when the rollback step failed. A
// rollback is run in an incident, so a rollback that refused, failed, or rolled back to
// something that is not healthy either is the worst possible thing to leave in the
// Actions tab with nobody reading it.
//
// It quotes the ending the rollback script wrote (ROLLBACK_SUMMARY_FILE) rather than
// guessing at one, and says plainly when there is none: a script that died before it
// wrote anything may have rolled back or may not have, and only the run log can say.
//
// Bare node, no dependency install and no alias hook, like every alerter (#1598):
// scripts/test-dependency-free-scripts.ts walks its import graph.
import { readFileSync } from "node:fs";
import { runAlerter } from "./lib/run-alerter.ts";
import { postToAlertsChannel } from "./lib/slack-post.ts";

export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

/** The ending the rollback wrote, or null when none reached this process. */
export function readRollbackSummary(path: string): { exit: number; message: string } | null {
  if (!path.trim()) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { exit?: unknown; message?: unknown };
    if (typeof parsed.exit !== "number" || typeof parsed.message !== "string") return null;
    return { exit: parsed.exit, message: parsed.message };
  } catch {
    return null;
  }
}

/** One place for the wording (L41). */
export function buildRollbackAlert(
  summary: { exit: number; message: string } | null,
  ctx: { runUrl: string; actor: string },
): string {
  const who = ctx.actor.trim() ? ` started by ${ctx.actor.trim()}` : "";
  const lines = [
    summary
      ? `The production rollback${who} did not end cleanly (exit ${summary.exit}). ${summary.message}`
      : `The production rollback${who} stopped before it reported an ending, so it may or may not have rolled back. Check which version is serving before doing anything else.`,
  ];
  lines.push(ctx.runUrl.trim() || "Open the Rollback workflow in the Actions tab.");
  return lines.join("\n");
}

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; reason: string }> {
  const text = buildRollbackAlert(readRollbackSummary(env.ROLLBACK_SUMMARY_FILE ?? ""), {
    runUrl: env.RUN_URL ?? "",
    actor: env.ACTOR ?? "",
  });
  return postToAlertsChannel(post, text, env);
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env);
  if (!res.ok) {
    console.error(
      `::error title=Rollback alert not sent::Could not post the Slack rollback alert (${res.reason}). Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo Actions settings.`,
    );
    return 1;
  }
  console.log("Posted rollback alert to Slack.");
  return 0;
});

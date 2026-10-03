// Speak about the weekly router replay, and stamp its heartbeat when it concluded
// (#2263).
//
// Invoked by .github/workflows/router-replay.yml after the replay step, whatever
// that step's exit code was. It does two things a hand run does by somebody reading
// the terminal: decides whether the detector reached a usable verdict, and decides
// whether anybody needs telling.
//
// The DECISION is in `lib/router-replay-report.ts` and pinned offline, because the
// three states it separates (agreement, a finding, a run that never decided) all
// render as an exit code otherwise, and one answering for another is how somebody
// spends an afternoon on the wrong thing (L11).
//
// Bare node, no dependency install and no alias hook, like its siblings: this is
// the step that has to still work when something has already gone wrong, and every
// dependency it carries is another way for it to be unavailable exactly then
// (#1598).
//
// Fails loud: a Slack post that errors, or Slack being unconfigured while there is
// something to say, exits non-zero so the job goes visibly red rather than
// pretending it warned anyone.
import { readFileSync, appendFileSync } from "node:fs";
import { runAlerter } from "./lib/run-alerter.ts";
import { postConcludedDecision } from "./lib/post-decision.ts";
import { decideReplayReport, type ReplaySummaryFile } from "./lib/router-replay-report.ts";

export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

/**
 * The verdict the replay wrote, or null when it never reached one.
 *
 * A file that is absent, unreadable or not the shape this expects is all the same
 * fact: no verdict got here. It is deliberately NOT distinguished further, because
 * every one of them means the run has to be looked at and the message says so.
 */
export function readSummary(path: string): ReplaySummaryFile | null {
  if (!path.trim()) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { outcome, exit, detail } = parsed as Record<string, unknown>;
    if (typeof outcome !== "string") return null;
    return {
      outcome,
      exit: typeof exit === "number" ? exit : -1,
      detail: typeof detail === "string" ? detail : "",
    };
  } catch {
    return null;
  }
}

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; reason: string; concluded: boolean }> {
  const decision = decideReplayReport(
    readSummary(env.REPLAY_SUMMARY_FILE ?? ""),
    env.RUN_URL ?? "",
  );
  return postConcludedDecision(post, env, decision);
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env);
  // Written whatever happened to the Slack post: whether the detector CONCLUDED
  // is a fact about the replay, and losing it because Slack was misconfigured
  // would leave the heartbeat unstamped for a reason that has nothing to do with
  // the replay (L53, two checks must never share one status).
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `concluded=${res.concluded ? "1" : "0"}\n`, "utf8");
  if (!res.ok) {
    console.error(
      `::error title=Replay alert not sent::Could not post the Slack router-replay alert ` +
        `(${res.reason}). Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo Actions ` +
        `settings.`,
    );
    return 1;
  }
  console.log(`router replay: ${res.reason}; concluded=${res.concluded}`);
  return 0;
});

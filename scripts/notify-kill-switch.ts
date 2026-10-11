// Speak about the nightly kill switch proof, and say whether it reached a verdict (#2493).
//
// Invoked by .github/workflows/kill-switch.yml after the verification step, whatever that
// step's exit code was. It does the two things a hand run does by somebody reading the
// terminal: decides whether the check MEASURED anything, and decides whether anybody needs
// telling.
//
// The DECISION is in `lib/kill-switch-run-outcome.ts` and pinned offline, because the
// command has fourteen endings and half of them mean it never got to ask the question. A
// stamp on one of those would report the detector concluding while it is blind, which is
// the exact substitution the verdict family exists to stop (#1394, L98).
//
// Bare node, no dependency install and no alias hook, like its siblings: this is the step
// that has to still work when something has already gone wrong, and every dependency it
// carries is another way for it to be unavailable exactly then (#1598).
//
// Fails loud: a Slack post that errors, or Slack being unconfigured while there is
// something to say, exits non-zero so the job goes visibly red rather than pretending it
// warned anyone.
import { readRunSummary, writeConcludedOutput } from "./lib/run-summary-file.ts";
import { runAlerter } from "./lib/run-alerter.ts";
import { postConcludedDecision } from "./lib/post-decision.ts";
import {
  decideKillSwitchReport,
  type KillSwitchSummaryFile,
} from "./lib/kill-switch-run-outcome.ts";

export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

/**
 * The verdict the command wrote, or null when none reached this process.
 *
 * A file that is absent, unreadable or not the shape this expects is all the same fact: no
 * verdict got here. It is deliberately NOT distinguished further, because every one of
 * them means the run has to be looked at and the message says so.
 */
export function readSummary(path: string): KillSwitchSummaryFile | null {
  // One reader for every scheduled proof (scripts/lib/run-summary-file.ts, #3340).
  return readRunSummary(path);
}

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; reason: string; concluded: boolean }> {
  const decision = decideKillSwitchReport(
    readSummary(env.KILL_SWITCH_SUMMARY_FILE ?? ""),
    env.RUN_URL ?? "",
  );
  return postConcludedDecision(post, env, decision);
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env);
  // Written whatever happened to the Slack post: whether the check CONCLUDED is a fact
  // about the run, and losing it because Slack was misconfigured would leave the
  // heartbeat unstamped for a reason that has nothing to do with the switch (L53).
  writeConcludedOutput(res.concluded);
  if (!res.ok) {
    console.error(
      `::error title=Kill switch alert not sent::Could not post the Slack kill-switch alert ` +
        `(${res.reason}). Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo Actions ` +
        `settings.`,
    );
    return 1;
  }
  console.log(`kill switch: ${res.reason}; concluded=${res.concluded}`);
  return 0;
});

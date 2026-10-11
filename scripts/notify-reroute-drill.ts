// Speak about the daily reroute drill, and say whether it reached a verdict (#3615).
//
// Invoked by .github/workflows/burst-counter.yml after the drill step, whatever that step's exit
// code was. Whether the drill MEASURED anything (the stamp) and whether anybody needs telling (the
// post) are decided in `lib/reroute-drill-run-outcome.ts`, which is pinned offline.
//
// Bare node, no install and no alias hook, like every alerter here: this is the step that has to
// work when something has already gone wrong (#1598), and scripts/test-dependency-free-scripts.ts
// holds it to importing nothing outside scripts/.
//
// Fails loud: a Slack post that errors, or Slack unconfigured while there is something to say,
// exits non-zero so the job goes red rather than pretending it warned anyone.
import { runAlerter } from "./lib/run-alerter.ts";
import { postConcludedDecision, type PostFn } from "./lib/post-decision.ts";
import { readRunSummary, writeConcludedOutput } from "./lib/run-summary-file.ts";
import { decideRerouteDrillReport } from "./lib/reroute-drill-run-outcome.ts";

export async function run(post: PostFn, env: Record<string, string | undefined>) {
  const verdict = readRunSummary(env.REROUTE_DRILL_SUMMARY_FILE ?? "");
  return postConcludedDecision(post, env, decideRerouteDrillReport(verdict, env.RUN_URL ?? ""));
}

runAlerter(import.meta.url, async (post, env) => {
  const result = await run(post, env);
  // Whether the drill CONCLUDED is a fact about the pipeline, so it is written whatever became of
  // the post: a Slack fault must not leave the verdict unstamped (L53).
  writeConcludedOutput(result.concluded);
  if (!result.ok) {
    console.error(
      `::error title=Reroute drill alert not sent::The reroute drill's Slack post failed (${result.reason}). ` +
        "Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo Actions settings.",
    );
    return 1;
  }
  console.log(`reroute drill: ${result.reason}; concluded=${result.concluded}`);
  return 0;
});

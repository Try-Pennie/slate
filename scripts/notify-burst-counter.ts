// Speak about the daily burst counter proof, and say whether it reached a verdict (#2392).
//
// Invoked by .github/workflows/burst-counter.yml after the verification step, whatever
// that step's exit code was. It does the two things a hand run does by somebody reading
// the terminal: decides whether the check MEASURED anything, and decides whether anybody
// needs telling.
//
// The DECISION is in `lib/burst-counter-run-outcome.ts` and pinned offline, because the
// command has thirteen endings and most of them mean it never got to ask the question.
// A stamp on one of those would report the detector concluding while it is blind, which
// is the exact substitution the verdict family exists to stop (#1394, L98).
//
// Bare node, no dependency install and no alias hook, like its siblings: this is the step
// that has to still work when something has already gone wrong, and every dependency it
// carries is another way for it to be unavailable exactly then (#1598).
//
// Fails loud: a Slack post that errors, or Slack being unconfigured while there is
// something to say, exits non-zero so the job goes visibly red rather than pretending it
// warned anyone.
import { readFileSync, appendFileSync } from "node:fs";
import { runAlerter } from "./lib/run-alerter.ts";
import {
  decideBurstCounterReport,
  type BurstSummaryFile,
} from "./lib/burst-counter-run-outcome.ts";

export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

/**
 * The verdict the command wrote, or null when none reached this process.
 *
 * A file that is absent, unreadable or not the shape this expects is all the same fact:
 * no verdict got here. It is deliberately NOT distinguished further, because every one
 * of them means the run has to be looked at and the message says so.
 */
export function readSummary(path: string): BurstSummaryFile | null {
  if (!path.trim()) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { exit, detail } = parsed as Record<string, unknown>;
    // The exit code is the whole judgement, so a missing or unreadable one is NOT
    // defaulted to anything: a default would pick some other ending's meaning, and
    // "no verdict got here" is the honest reading of a file that cannot say which.
    if (typeof exit !== "number" || !Number.isFinite(exit)) return null;
    return { exit, detail: typeof detail === "string" ? detail : "" };
  } catch {
    return null;
  }
}

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; reason: string; concluded: boolean }> {
  const decision = decideBurstCounterReport(
    readSummary(env.BURST_SUMMARY_FILE ?? ""),
    env.RUN_URL ?? "",
  );
  if (decision.alert === null) {
    return { ok: true, reason: "nothing to say", concluded: decision.concluded };
  }
  // The channel comes from the workflow, never from a database lookup (#1598). An empty
  // value is refused by name rather than posted into nowhere, because an unset repo
  // variable interpolates to the empty string.
  const channel = env.SLACK_ALERTS_CHANNEL?.trim() || undefined;
  const res = await post({ text: decision.alert, ...(channel ? { channel } : {}) });
  return {
    ok: res.ok,
    reason: res.ok ? "posted" : (res.error ?? "unknown-error"),
    concluded: decision.concluded,
  };
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env);
  // Written whatever happened to the Slack post: whether the check CONCLUDED is a fact
  // about the run, and losing it because Slack was misconfigured would leave the
  // heartbeat unstamped for a reason that has nothing to do with the counter (L53).
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `concluded=${res.concluded ? "1" : "0"}\n`, "utf8");
  if (!res.ok) {
    console.error(
      `::error title=Burst counter alert not sent::Could not post the Slack burst-counter ` +
        `alert (${res.reason}). Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo ` +
        `Actions settings.`,
    );
    return 1;
  }
  console.log(`burst counter: ${res.reason}; concluded=${res.concluded}`);
  return 0;
});

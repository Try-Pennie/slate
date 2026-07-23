// Pure classification for the main-push backstop (#1027). Kept free of I/O so it
// is unit-testable with hand-written inputs (no module mocking, per the node
// script convention). The workflow gathers the GitHub context and the runner
// (scripts/check-main-push.ts) turns a violation into a Slack alert + a red run.

/** A commit-message marker that authorizes a deliberate direct push to main. */
export const BYPASS_MARKER = "[allow-direct-push]";

export interface AssociatedPr {
  number: number;
  /** True when this PR is the merged PR that introduced the commit. */
  merged: boolean;
  /** CI conclusion on the PR head: "success" | "failure" | null (unknown). */
  ciConclusion: string | null;
}

export interface PushContext {
  headSha: string;
  commitMessage: string;
  actor: string;
  runUrl: string;
  prs: AssociatedPr[];
}

export interface Verdict {
  ok: boolean;
  reason: string;
}

/**
 * Decide whether a commit that landed on main arrived legitimately.
 *
 * Legitimate  = it came from a merged PR AND that PR's CI did not fail.
 * Violation   = a direct push with no merged PR (bypassed review), OR a merged
 *               PR whose CI concluded failure (a red merge).
 * Bypass      = the commit message carries BYPASS_MARKER (a deliberate hotfix).
 *
 * An unknown CI conclusion (null) is tolerated rather than alerted on, so a
 * transient inability to read checks never pages; the hard signal is "no merged
 * PR at all", which the free plan leaves completely unguarded today.
 */
export function classifyPush(ctx: PushContext): Verdict {
  if (ctx.commitMessage.includes(BYPASS_MARKER)) {
    return { ok: true, reason: `bypass marker ${BYPASS_MARKER} present` };
  }

  const merged = ctx.prs.filter((p) => p.merged);
  if (merged.length === 0) {
    return {
      ok: false,
      reason: "direct push to main with no merged PR (review bypassed)",
    };
  }

  const red = merged.find((p) => p.ciConclusion === "failure");
  if (red) {
    return { ok: false, reason: `merged PR #${red.number} had failing CI` };
  }

  return { ok: true, reason: `legitimate merge of PR #${merged[0].number}` };
}

export function buildViolationMessage(ctx: PushContext, verdict: Verdict): string {
  const shortSha = ctx.headSha ? ctx.headSha.slice(0, 7) : "unknown";
  const firstLine = (ctx.commitMessage || "").split("\n")[0] || "(no message)";
  return [
    "Slate main branch protection: a commit reached main illegitimately.",
    verdict.reason + ".",
    `Commit ${shortSha} by ${ctx.actor || "unknown"}: ${firstLine}`,
    "Review and revert if this was not intended. A deliberate direct push must " +
      `carry the ${BYPASS_MARKER} marker.`,
    ctx.runUrl,
  ].join("\n");
}

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
  /**
   * Whether the PR list was actually READ (#1436).
   *
   * The workflow used to gather it as `pulls="$(gh api ... || echo '[]')"`, so a
   * GitHub outage produced an empty array, which is byte for byte what a genuine
   * direct push looks like. The guard then failed the run and paged saying "direct
   * push to main with no merged PR (review bypassed)": an accusation about
   * something it never measured (L11). Both still fail, because a push to main we
   * cannot vouch for must not go quiet, but they must not say the same thing.
   */
  prsReadable: boolean;
}

export interface Verdict {
  ok: boolean;
  reason: string;
  /** True when the run failed because it could NOT tell, not because it found a
   *  violation. Absent means a real measurement was made. */
  unverified?: boolean;
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
 *
 * Unverifiable = the PR list could not be read at all (#1436). That fails, like
 * every other not-ok verdict, but it is reported as what it is rather than as a
 * direct push, because an empty list and an unreadable one are indistinguishable
 * from here and only one of them is somebody bypassing review.
 */
export function classifyPush(ctx: PushContext): Verdict {
  if (ctx.commitMessage.includes(BYPASS_MARKER)) {
    return { ok: true, reason: `bypass marker ${BYPASS_MARKER} present` };
  }

  if (!ctx.prsReadable) {
    return {
      ok: false,
      unverified: true,
      reason:
        "could not read the pull requests for this commit, so whether it arrived through a " +
        "merged PR is UNKNOWN. This is not a direct push; it is a check that could not run",
    };
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
  // The unverified case gets its own opening line and its own instruction. Telling
  // someone to review and revert a commit, when the only thing that happened is
  // that GitHub did not answer, is advice that cannot fix the state they are in
  // (L111), and it is how a guard teaches people to ignore it.
  const opening = verdict.unverified
    ? "Slate main branch protection could not check a commit that reached main."
    : "Slate main branch protection: a commit reached main illegitimately.";
  const closing = verdict.unverified
    ? "Re-run the main-push-guard job. If it keeps failing, check by hand whether this commit " +
      "came from a merged PR: until then main is unguarded, not proven bad."
    : "Review and revert if this was not intended. A deliberate direct push must " +
      `carry the ${BYPASS_MARKER} marker.`;
  return [
    opening,
    verdict.reason + ".",
    `Commit ${shortSha} by ${ctx.actor || "unknown"}: ${firstLine}`,
    closing,
    ctx.runUrl,
  ].join("\n");
}

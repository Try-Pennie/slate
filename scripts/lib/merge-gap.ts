/**
 * Pure classification for the server-side merge-gap backstop (#113, rewritten in
 * #1436). Kept free of IO so it is unit-testable with hand-written inputs.
 *
 * What it protects: PRs here are merged within seconds, so a follow-up commit
 * pushed to a branch whose PR already merged is STRANDED. It never reaches main,
 * and nothing says so. The local pre-push hook catches it interactively but fails
 * open by design (no gh, no hooksPath, non-interactive contexts), which is why
 * this workflow exists.
 *
 * Why the decision moved out of the `run:` block: the backstop had the same
 * failure mode as the thing it compensates for. It read the PR list as
 * `states="$(gh pr list ... || echo '')"`, so a gh outage produced an empty
 * string, no state matched, and the job printed "No merged/closed PR blocking"
 * and exited 0. A compensating control that reports green having asked nothing is
 * worse than no control, because it is believed (#1433, L98).
 *
 * The fix is the distinction this module exists to hold: **an empty answer and no
 * answer are different outcomes.** A branch with no PR yet is genuinely fine. A
 * branch whose PR list could not be read is unverified, and it fails.
 */

/** What the `gh pr list` read produced: states, or a reason it could not be had. */
export type PrStateRead =
  | { ok: true; states: string[] }
  | { ok: false; reason: string };

export interface MergeGapVerdict {
  /** False fails the run. */
  ok: boolean;
  /** True when the run failed because it could NOT tell, not because it found a gap. */
  unverified: boolean;
  /** What was decided, in a sentence the person who just pushed can act on. */
  reason: string;
}

/** GitHub's PR states, normalized. Anything else is not a state we know. */
const OPEN = "OPEN";
const CLOSED = new Set(["MERGED", "CLOSED"]);

export function mergeGapVerdict(read: PrStateRead, branch: string): MergeGapVerdict {
  if (!read.ok) {
    return {
      ok: false,
      unverified: true,
      reason:
        `could not read the pull request list for '${branch}' (${read.reason}), so whether a ` +
        `commit pushed here strands is UNKNOWN. Failing rather than reporting green having ` +
        `asked nothing. Re-run the job; if GitHub is down, check by hand before relying on this.`,
    };
  }

  const states = read.states.map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0);

  // A still-open PR is legitimate: active work, or a PR reopened under the same
  // branch name. It wins over merged/closed history, which is why it is checked
  // first rather than counting states.
  if (states.includes(OPEN)) {
    return { ok: true, unverified: false, reason: `an open pull request exists for '${branch}'` };
  }
  if (states.some((s) => CLOSED.has(s))) {
    return {
      ok: false,
      unverified: false,
      reason:
        `branch '${branch}' has a merged or closed pull request and no open one. Commits pushed ` +
        `here strand and never reach main. Branch fresh off main and cherry-pick instead ` +
        `(ALLOW_MERGED_PUSH bypasses only the local hook, not this).`,
    };
  }
  if (states.length === 0) {
    // Read successfully, and there really is no PR. The common case for a first
    // push, and the one an unreadable list used to be indistinguishable from.
    return {
      ok: true,
      unverified: false,
      reason: `no pull request has been opened for '${branch}' yet, so nothing can strand`,
    };
  }
  // States came back, none of them recognized. Not a pass: GitHub's vocabulary
  // changing must not silently turn this into a no-op (L113).
  return {
    ok: false,
    unverified: true,
    reason:
      `the pull request list for '${branch}' returned states this guard does not recognize ` +
      `(${states.join(", ")}), so it cannot say whether a commit here strands. Failing rather ` +
      `than guessing.`,
  };
}

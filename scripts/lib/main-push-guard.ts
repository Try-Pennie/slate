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

/**
 * A merge confirmed from the PR's OWN record rather than from GitHub's
 * commit-to-PR association index (#1447).
 *
 * The association index can be permanently missing an entry. On 2026-08-13
 * `/commits/<sha>/pulls` returned `[]` for a squash merge of a reviewed, green PR,
 * and still did twenty minutes later, while that PR reported the same commit as its
 * `merge_commit_sha`. The merge had gone through during a GitHub API incident, so
 * the record was never written and no retry could have helped.
 *
 * An empty association is byte for byte what a direct push looks like, so a guard
 * with only that one lookup accuses on a missing index entry (L119). This is the
 * independent second route: it comes from the pull request record, and a direct push
 * cannot fabricate it, because it would have to make some merged PR's own
 * merge_commit_sha equal the pushed commit.
 */
export interface MergeCommitClaim {
  number: number;
  /** True when the PR is merged AND its merge_commit_sha is the commit under test. */
  isMergeCommitOfThisPush: boolean;
  /** CI conclusion on the PR head, same vocabulary as the association read. */
  ciConclusion: string | null;
}

export interface PushContext {
  headSha: string;
  commitMessage: string;
  actor: string;
  runUrl: string;
  prs: AssociatedPr[];
  /**
   * PRs named in the commit SUBJECT whose own record claims this commit as their
   * merge commit (#1447). Consulted whenever the association established no merge,
   * which is BOTH an empty index and a read that FAILED (#1519): it is a fallback
   * route to establishing that a merge HAPPENED, never a second opinion on whether
   * the merge was acceptable, and a red CI is still refused on it.
   */
  claimedBy?: MergeCommitClaim[];
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
 * Legitimate  = it came from a merged PR AND that PR's CI did not fail. "Came from a
 *               merged PR" is established by GitHub's commit association, or, when
 *               that index establishes nothing (empty, or unreadable), by a PR named
 *               in the commit subject whose own record claims this commit as its
 *               merge commit (#1447, #1519).
 * Violation   = a direct push with no merged PR (bypassed review), OR a merged
 *               PR whose CI concluded failure (a red merge).
 * Bypass      = the commit SUBJECT carries BYPASS_MARKER (a deliberate hotfix). The body
 *               is never read for it (#4096, L801): a squash merge's body is every commit
 *               message on the branch, so a branch that only MENTIONS the marker, as any
 *               change to this guard or its docs does, would exempt its own red merge.
 *
 * An unknown CI conclusion (null) is tolerated rather than alerted on, so a
 * transient inability to read checks never pages; the hard signal is "no merged
 * PR at all", which the free plan leaves completely unguarded today.
 *
 * Unverifiable = the PR list could not be read at all (#1436) AND no PR named in the
 * subject claims this commit. That fails, like every other not-ok verdict, but it is
 * reported as what it is rather than as a direct push, because an empty list and an
 * unreadable one are indistinguishable from here and only one of them is somebody
 * bypassing review. When a claim IS present the merge is established and the run
 * passes, saying that the primary read is down (#1519).
 */
/** The first line of a commit message, the only part this guard reads. */
export function commitSubject(commitMessage: string): string {
  return (commitMessage || "").split("\n")[0] ?? "";
}

export function classifyPush(ctx: PushContext): Verdict {
  if (commitSubject(ctx.commitMessage).includes(BYPASS_MARKER)) {
    return { ok: true, reason: `bypass marker ${BYPASS_MARKER} present` };
  }

  // #1447/#1519: the pull requests named in the commit subject that claim this
  // very commit as their merge commit. This is the INDEPENDENT route, read from
  // each PR's own record rather than from GitHub's derived association index, and
  // it is consulted whenever the association has not established a merge, whether
  // it came back empty or could not be read at all.
  const claimed = (ctx.claimedBy ?? []).filter((c) => c.isMergeCommitOfThisPush);

  if (!ctx.prsReadable) {
    // #1519: an unreadable association used to return here immediately, above the
    // claim route. The route was written for the association answering EMPTY,
    // which is what the 2026-08-13 incident produced, and a read that FAILS is the
    // harder version of the same failure and the one a second route exists for. On
    // 2026-08-17 the endpoint began answering 403 to the workflow token, and the
    // guard fetched the proof, logged it, and threw it away: every merge to main
    // failed and paged, and no re-run could help. A route reachable only when the
    // primary answers is not a fallback (L161).
    //
    // It still FAILS CLOSED. With no claim there is nothing to stand on and the
    // verdict is the same unverified one as before; this only stops the guard
    // discarding proof it is already holding.
    if (claimed.length === 0) {
      return {
        ok: false,
        unverified: true,
        reason:
          "could not read the pull requests for this commit, so whether it arrived through a " +
          "merged PR is UNKNOWN. This is not a direct push; it is a check that could not run",
      };
    }
    const redBlind = claimed.find((c) => c.ciConclusion === "failure");
    if (redBlind) {
      return { ok: false, reason: `merged PR #${redBlind.number} had failing CI` };
    }
    // L65: the primary route is DOWN, and a run rescued by the fallback must say
    // so. Passing silently would leave the guard running on one leg indefinitely,
    // indistinguishable from a healthy one, which is how the 403 stays invisible.
    return {
      ok: true,
      reason:
        `legitimate merge of PR #${claimed[0]!.number}, confirmed from that PR's own merge ` +
        `commit because GitHub's commit association could not be read. That primary read is ` +
        `DOWN and wants fixing: this run passed on the fallback route alone`,
    };
  }

  const merged = ctx.prs.filter((p) => p.merged);
  if (merged.length === 0) {
    // #1447: before accusing anyone, ask the pull requests named in the commit
    // subject whether one of them claims this commit as its merge commit. GitHub's
    // association index can be permanently missing the entry, and an empty index is
    // indistinguishable from a real direct push (L119).
    if (claimed.length === 0) {
      return {
        ok: false,
        reason: "direct push to main with no merged PR (review bypassed)",
      };
    }
    // The merge is established. It is still judged on the same terms, so a merged
    // PR whose CI failed is caught whichever route found it.
    const redClaim = claimed.find((c) => c.ciConclusion === "failure");
    if (redClaim) {
      return { ok: false, reason: `merged PR #${redClaim.number} had failing CI` };
    }
    return {
      ok: true,
      reason:
        `legitimate merge of PR #${claimed[0]!.number}, confirmed from that PR's own merge ` +
        `commit because GitHub's commit association was empty`,
    };
  }

  const red = merged.find((p) => p.ciConclusion === "failure");
  if (red) {
    return { ok: false, reason: `merged PR #${red.number} had failing CI` };
  }

  return { ok: true, reason: `legitimate merge of PR #${merged[0].number}` };
}

/**
 * The pull request numbers named in a commit SUBJECT (#1447).
 *
 * Every squash merge here ends with `(#1446)`, and the PR body's own `(#1435)` style
 * issue references ride along in the subject too, so this returns all of them and
 * lets the caller ask GitHub which (if any) actually claims the commit. Asking about
 * an issue number is harmless: an issue is not a pull request, so it cannot claim a
 * merge commit.
 *
 * Only the SUBJECT is read, never the body. A squash body is every commit message
 * from the branch, so it can name dozens of unrelated PRs, and each one would be
 * another API call on a guard that runs on every push.
 */
export function prNumbersInSubject(commitMessage: string): number[] {
  const subject = commitSubject(commitMessage);
  const found: number[] = [];
  for (const m of subject.matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    // A bounded, plausible PR number. Rejecting 0 matters: `#0` is not a PR, and
    // asking about it would spend a request to be told so on every push.
    if (Number.isInteger(n) && n > 0 && !found.includes(n)) found.push(n);
  }
  return found;
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
      `carry the ${BYPASS_MARKER} marker in its subject line.`;
  return [
    opening,
    verdict.reason + ".",
    `Commit ${shortSha} by ${ctx.actor || "unknown"}: ${firstLine}`,
    closing,
    ctx.runUrl,
  ].join("\n");
}

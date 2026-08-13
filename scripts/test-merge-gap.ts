// The server-side merge-gap backstop (#113), and the #1436 defect in it.
//
// PRs here merge within seconds, so a follow-up commit pushed onto a branch whose
// PR already merged is STRANDED: it never reaches main and nothing says so. The
// local pre-push hook catches that interactively but fails open by design, which
// is the entire reason this workflow exists.
//
// The defect: the backstop had the same failure mode as the thing it compensates
// for. It read the PR list as `states="$(gh pr list ... || echo '')"`, so a gh
// outage produced an empty string, nothing matched, and the job printed "No
// merged/closed PR blocking" and exited 0. A compensating control that reports
// green having asked nothing is worse than no control, because it is believed.
//
// So the property this suite exists for is the DISTINCTION: an empty answer and no
// answer are different outcomes, and only one of them is safe to pass.
//
// Run: node --experimental-strip-types scripts/test-merge-gap.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { mergeGapVerdict, type PrStateRead } from "./lib/merge-gap.ts";

const BRANCH = "fix/1436-ci-parse-sweep";
const read = (...states: string[]): PrStateRead => ({ ok: true, states });

// --- an unreadable list FAILS, and says it could not tell ------------------
// The headline. This is the case that used to exit 0.
{
  const v = mergeGapVerdict({ ok: false, reason: "gh api returned 502" }, BRANCH);
  assert(!v.ok, "#1436: a PR list that could not be read FAILS the run");
  assert(v.unverified, "and is marked unverified, so it is not mistaken for having found a gap");
  assert(/UNKNOWN|could not read/i.test(v.reason), "the reason says it could not tell");
  assert(v.reason.includes("502"), "and carries what actually went wrong");
  assert(
    !/no merged/i.test(v.reason),
    "and never claims there is no merged PR, which it did not measure (L11)",
  );
}

// --- no PR at all is a PASS, and is told apart from unreadable ------------
// The first push on a new branch. Under the old shape this was the SAME string as
// a failed read, which is exactly why the failure could hide here.
{
  const v = mergeGapVerdict(read(), BRANCH);
  assert(v.ok, "a branch with no pull request yet passes");
  assert(!v.unverified, "and is a real measurement, not an unverified one");
  assert(/no pull request/i.test(v.reason), "saying so in words");
}

// --- a merged PR blocks --------------------------------------------------
{
  const v = mergeGapVerdict(read("MERGED"), BRANCH);
  assert(!v.ok, "a branch whose PR merged is blocked");
  assert(!v.unverified, "and this IS a measurement: it found the gap");
  assert(/strand/i.test(v.reason), "the reason says what goes wrong (the commit strands)");
  assert(/cherry-pick/i.test(v.reason), "and names the way out, which is the action the person takes");
}
{
  const v = mergeGapVerdict(read("CLOSED"), BRANCH);
  assert(!v.ok, "a closed PR blocks too: a commit pushed there reaches nothing either");
}

// --- an open PR wins over merged history --------------------------------
// A reopened PR, or a second PR from the same branch name. Checked as "is OPEN
// present" rather than by counting, because both can be true at once and the open
// one is the live route to main.
{
  assert(mergeGapVerdict(read("OPEN"), BRANCH).ok, "an open PR passes");
  assert(
    mergeGapVerdict(read("MERGED", "OPEN"), BRANCH).ok,
    "an open PR alongside merged history passes: there IS a live route to main",
  );
  assert(
    mergeGapVerdict(read("CLOSED", "MERGED", "OPEN"), BRANCH).ok,
    "and the order the states arrive in does not change that",
  );
}

// --- states are normalized, not matched by luck -------------------------
{
  assert(!mergeGapVerdict(read("merged"), BRANCH).ok, "a lowercase state is still a merged PR");
  assert(mergeGapVerdict(read(" OPEN "), BRANCH).ok, "surrounding whitespace does not hide an open PR");
  assert(
    mergeGapVerdict(read("", "  ", "OPEN"), BRANCH).ok,
    "blank lines in the output are ignored rather than counted as states",
  );
  eq(
    mergeGapVerdict(read("", "   "), BRANCH).ok,
    true,
    "output that is only blank lines is the no-PR case, not an unrecognized one",
  );
}

// --- an unrecognized state FAILS rather than passing quietly ------------
// L113: a check keyed on a vocabulary silently takes its default branch for the
// value nobody added, and a default is indistinguishable from a deliberate choice.
// If GitHub renamed its states, this guard must go red rather than become a no-op.
{
  const v = mergeGapVerdict(read("DRAFT_SOMETHING_NEW"), BRANCH);
  assert(!v.ok, "a state this guard does not know fails the run");
  assert(v.unverified, "as unverified: it is a vocabulary problem, not a found gap");
  assert(
    v.reason.includes("DRAFT_SOMETHING_NEW"),
    "and names the state it could not interpret, so the fix is obvious",
  );
}

// --- the two failure kinds never read the same -------------------------
// A person reading the job log has to be able to tell "you are about to strand a
// commit" from "GitHub did not answer": the first is their problem to fix, the
// second is a re-run.
{
  const gap = mergeGapVerdict(read("MERGED"), BRANCH);
  const blind = mergeGapVerdict({ ok: false, reason: "network" }, BRANCH);
  assert(!gap.ok && !blind.ok, "both fail");
  assert(gap.unverified !== blind.unverified, "but they are distinguishable in the verdict");
  assert(gap.reason !== blind.reason, "and in what the reader is told");
}

finish();

// Server-side backstop for direct pushes to main (#1027). Native GitHub branch
// protection needs a paid org plan, so this is the free compensating control: a
// workflow fires on push to main and this classifier decides whether the commit
// arrived legitimately (through a merged PR whose CI passed) or bypassed review.
// A violation fails the run AND posts a Slack alert. It is DETECTIVE (fires after
// the push/deploy), documented as residual risk in AGENTS.md.
//
// This exercises the happy path AND both failure paths (direct push, merged red
// PR) plus the Slack-unconfigured send failure, per the failure-path test rule.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-main-push-guard.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  BYPASS_MARKER,
  classifyPush,
  buildViolationMessage,
  prNumbersInSubject,
  type PushContext,
} from "./lib/main-push-guard.ts";
import { run, readContextFromEnv, type PostFn } from "./check-main-push.ts";

const base: PushContext = {
  headSha: "abcdef1234567890",
  commitMessage: "Add a thing (#42)",
  actor: "someone",
  runUrl: "https://github.com/Try-Pennie/slate/actions/runs/1",
  prs: [{ number: 42, merged: true, ciConclusion: "success" }],
  prsReadable: true,
};

// --- classifier ----------------------------------------------------------
assert(classifyPush(base).ok, "legitimate: one merged PR with passing CI is allowed");

const directPush = { ...base, prs: [] };
assert(!classifyPush(directPush).ok, "violation: direct push with no merged PR is flagged");

const bypass = { ...directPush, commitMessage: `Hotfix main ${BYPASS_MARKER}` };
assert(classifyPush(bypass).ok, "bypass: the documented marker allows a deliberate direct push");

const mergedRed = {
  ...base,
  prs: [{ number: 42, merged: true, ciConclusion: "failure" }],
};
assert(!classifyPush(mergedRed).ok, "violation: a merged PR whose CI failed is flagged");

// An open (not merged) PR associated with the commit is NOT a legitimate merge.
const openOnly = { ...base, prs: [{ number: 42, merged: false, ciConclusion: "success" }] };
assert(!classifyPush(openOnly).ok, "violation: an associated but unmerged PR does not count as a merge");

// The alert names the actor and the short sha so a human can act fast.
const msg = buildViolationMessage(directPush, classifyPush(directPush));
assert(/someone/.test(msg) && /abcdef1/.test(msg), "violation message names the actor and short sha");

// --- runner (with a fake poster) -----------------------------------------
function fakePoster(result: { ok: boolean; error?: string }) {
  const calls: Array<{ text: string; channel?: string }> = [];
  const post: PostFn = async (m) => {
    calls.push(m);
    return result;
  };
  return { post, calls };
}

const envFor = (ctx: PushContext) => ({
  HEAD_SHA: ctx.headSha,
  COMMIT_MESSAGE: ctx.commitMessage,
  ACTOR: ctx.actor,
  RUN_URL: ctx.runUrl,
  PRS_JSON: JSON.stringify(ctx.prs),
  SLACK_ALERTS_CHANNEL: "#alerts",
});

// readContextFromEnv round-trips the PRs JSON.
eq(readContextFromEnv(envFor(base)).prs.length, 1, "readContextFromEnv parses PRS_JSON");

// Legitimate: no Slack post, ok.
{
  const { post, calls } = fakePoster({ ok: true });
  const res = await run(post, envFor(base));
  assert(res.ok && calls.length === 0, "legitimate push: passes and does not alert");
}

// Violation: posts and reports not-ok (so the run goes red).
{
  const { post, calls } = fakePoster({ ok: true });
  const res = await run(post, envFor(directPush));
  assert(!res.ok && res.alerted && calls.length === 1, "violation: alerts once and reports not-ok");
  assert(/#alerts/.test(calls[0].channel ?? ""), "alert goes to the configured channel");
}

// Violation + Slack send fails: still not-ok, and marks the alert as not sent
// (fail loud: the run must still go red, and we must not pretend we warned).
{
  const { post } = fakePoster({ ok: false, error: "slack-not-configured" });
  const res = await run(post, envFor(directPush));
  assert(!res.ok && !res.alerted, "violation with failed Slack send: not-ok and alerted=false");
}

// --- workflow wiring (static) --------------------------------------------
const ROOT = join(import.meta.dirname, "..");
const wf = readFileSync(join(ROOT, ".github", "workflows", "main-push-guard.yml"), "utf8");
assert(/on:\s*\n\s*push:\s*\n\s*branches:\s*\n\s*-\s*main\b/.test(wf), "workflow fires on push to main");
assert(/scripts\/check-main-push\.ts/.test(wf), "workflow invokes the check-main-push runner");
assert(/SLACK_BOT_TOKEN/.test(wf) && /SLACK_ALERTS_CHANNEL/.test(wf), "workflow passes the Slack secrets");

// --- #1436: an unreadable PR list is not a direct push ------------------
// The workflow used to gather the list as `pulls="$(gh api ... || echo '[]')"`, and
// an empty array is byte for byte what a genuine direct push looks like. So a
// GitHub outage failed the run AND paged saying somebody had bypassed review: an
// accusation about something the check never measured (L11).
{
  const blind = { ...base, prs: [], prsReadable: false };
  const verdict = classifyPush(blind);
  assert(!verdict.ok, "an unreadable PR list still fails: a push to main we cannot vouch for is not silent");
  assert(verdict.unverified, "but it is marked unverified rather than being scored as a violation");
  assert(
    /UNKNOWN|could not read/i.test(verdict.reason),
    "and the reason says it could not tell",
  );
  assert(
    !/bypass/i.test(verdict.reason) && !/direct push to main with no merged/i.test(verdict.reason),
    "and never accuses anyone of bypassing review",
  );

  // The two failures must not read the same to the person holding the phone: one
  // is a commit to review, the other is a job to re-run, and telling someone to
  // revert over a GitHub blip is advice that cannot fix the state they are in.
  const blindMsg = buildViolationMessage(blind, verdict);
  const realMsg = buildViolationMessage(directPush, classifyPush(directPush));
  assert(/could not check/i.test(blindMsg), "the unverified alert says the check could not run");
  assert(/[Rr]e-run/.test(blindMsg), "and tells the reader to re-run the job");
  assert(!/revert/i.test(blindMsg), "and does NOT tell them to revert a commit that may be fine");
  assert(/revert/i.test(realMsg), "while a real violation still says to review and revert");
  assert(blindMsg !== realMsg, "the two never render the same");

  // An unreadable list beats even a bypass marker? No: a deliberate hotfix is
  // still legitimate, and the marker is checked first on purpose.
  const marked = { ...blind, commitMessage: `Hotfix main ${BYPASS_MARKER}` };
  assert(classifyPush(marked).ok, "a deliberate marked hotfix is still allowed when the list is unreadable");
}

// --- the env read defaults to READABLE only when nothing went wrong -----
{
  const readable = readContextFromEnv({ PRS_JSON: "[]" });
  assert(readable.prsReadable, "no PRS_READ_ERROR means the read succeeded (the normal case)");

  const failed = readContextFromEnv({ PRS_JSON: "[]", PRS_READ_ERROR: "gh api 502" });
  assert(!failed.prsReadable, "a recorded read error is carried through");

  // The ambiguous case falls on the SAFE side: anything present at all means the
  // read path went wrong, and defaulting it to readable would put it straight back
  // on the branch that accuses somebody of bypassing review.
  const blank = readContextFromEnv({ PRS_JSON: "[]", PRS_READ_ERROR: " " });
  assert(!blank.prsReadable, "a whitespace-only error value still counts as unreadable");
}

// --- #1447: an empty association is not proof of a direct push -------------
// A live false page. GitHub's commit-to-PR association index returned [] for the
// squash merge of a reviewed, green PR, and still did twenty minutes later, while
// that PR reported the same commit as its merge_commit_sha. The merge had gone
// through during a GitHub API incident so the record was never written, which is why
// no retry could have helped and why a second, independent route is the fix (L119).
{
  const claimed = {
    ...base,
    prs: [],
    commitMessage: "Refresh the served slot cache whenever an event type changes (#1435) (#1446)",
    claimedBy: [{ number: 1446, isMergeCommitOfThisPush: true, ciConclusion: "success" }],
  };
  const verdict = classifyPush(claimed);
  assert(verdict.ok, "#1447: a PR whose own record claims this commit is a legitimate merge");
  assert(!verdict.unverified, "and it is a real measurement, not an unverified one");
  assert(/#1446/.test(verdict.reason), "the reason names the PR that was confirmed");
  assert(
    /own merge commit|commit association was empty/.test(verdict.reason),
    "and says which ROUTE proved it, so a fallback confirmation is not silently identical to an association hit",
  );
}

// A genuine direct push is still caught: nothing claims the commit.
{
  const real = { ...base, prs: [], commitMessage: "Quick fix straight to main", claimedBy: [] };
  assert(!classifyPush(real).ok, "#1027: a real direct push is still flagged");
  assert(
    /review bypassed/.test(classifyPush(real).reason),
    "and still says review was bypassed",
  );
}

// A commit that NAMES a PR which does not claim it is not excused. This is the case
// that keeps the fallback honest: quoting an issue or PR number in a commit message
// is something anyone can do, so only the PR's own merge_commit_sha counts.
{
  const nameDropper = {
    ...base,
    prs: [],
    commitMessage: "Straight to main, mentioning (#1446) for no reason",
    claimedBy: [{ number: 1446, isMergeCommitOfThisPush: false, ciConclusion: "success" }],
  };
  assert(
    !classifyPush(nameDropper).ok,
    "#1447: naming a PR does NOT excuse a push; only that PR claiming this commit does",
  );
}

// The fallback establishes that a merge happened, it does not lower the bar for
// judging it: a merged PR whose CI failed is caught on either route.
{
  const redViaClaim = {
    ...base,
    prs: [],
    commitMessage: "Ship it (#99)",
    claimedBy: [{ number: 99, isMergeCommitOfThisPush: true, ciConclusion: "failure" }],
  };
  const verdict = classifyPush(redViaClaim);
  assert(!verdict.ok, "#1447: a red merge found via the fallback route is still a violation");
  assert(/#99/.test(verdict.reason) && /failing CI/.test(verdict.reason), "and is named as a red merge, not as a direct push");
}

// The association read still WINS when it has an answer, so the fallback is only
// ever reached when the index is empty (one fewer API call on the common path).
{
  const both = {
    ...base,
    claimedBy: [{ number: 777, isMergeCommitOfThisPush: true, ciConclusion: "failure" }],
  };
  const verdict = classifyPush(both);
  assert(verdict.ok, "an associated green merge is judged on the association");
  assert(/#42/.test(verdict.reason), "naming the associated PR rather than the claimant");
}

// An unreadable association is still unverified, not silently rescued by the
// fallback: if we could not ask GitHub about the association, we did not measure
// whether a merge happened, and the claim route is a different question.
{
  const blindWithClaim = {
    ...base,
    prs: [],
    prsReadable: false,
    claimedBy: [{ number: 1446, isMergeCommitOfThisPush: true, ciConclusion: "success" }],
  };
  const verdict = classifyPush(blindWithClaim);
  assert(!verdict.ok, "#1436 still holds: an unreadable association fails");
  assert(verdict.unverified, "as unverified, whatever the claim route says");
}

// --- the claims env read, and what it refuses to carry -------------------
{
  const good = readContextFromEnv({
    PRS_JSON: "[]",
    MERGE_CLAIMS_JSON: '[{"number":1446,"isMergeCommitOfThisPush":true,"ciConclusion":"success"}]',
  });
  eq(good.claimedBy?.length, 1, "a well-formed claim is carried through");
  eq(good.claimedBy?.[0]?.number, 1446, "with its PR number");
  assert(good.claimedBy?.[0]?.isMergeCommitOfThisPush === true, "and its claim");

  // Only a literal true excuses a push. A truthy string arriving from jq would
  // otherwise be enough, which is the whole gate this route rests on.
  const stringy = readContextFromEnv({
    MERGE_CLAIMS_JSON: '[{"number":9,"isMergeCommitOfThisPush":"true"}]',
  });
  assert(
    stringy.claimedBy?.[0]?.isMergeCommitOfThisPush === false,
    "a claim that is not literally true does not count as a claim",
  );

  // A claim whose number did not parse is dropped, not carried as NaN: it could
  // never excuse a push, but it WOULD reach a human as "PR #NaN", which claims
  // something the guard never measured and points at nothing.
  const junk = readContextFromEnv({
    MERGE_CLAIMS_JSON: '[{"number":"not-a-number","isMergeCommitOfThisPush":true}]',
  });
  eq(junk.claimedBy?.length, 0, "an unparseable PR number is dropped rather than becoming NaN");

  // Absent, blank and malformed all mean no claim, which is the fail-safe side:
  // this route can only ever EXCUSE a push.
  eq(readContextFromEnv({}).claimedBy?.length, 0, "no claims env means no claims");
  eq(readContextFromEnv({ MERGE_CLAIMS_JSON: "  " }).claimedBy?.length, 0, "a blank value means no claims");
  eq(readContextFromEnv({ MERGE_CLAIMS_JSON: "not json" }).claimedBy?.length, 0, "unparseable JSON means no claims");
  eq(
    readContextFromEnv({ MERGE_CLAIMS_JSON: '{"number":1}' }).claimedBy?.length,
    0,
    "a non-array means no claims rather than throwing on a push to main",
  );
}

// --- prNumbersInSubject: which PRs to ask about ---------------------------
{
  eq(
    prNumbersInSubject("Refresh the served slot cache whenever an event type changes (#1435) (#1446)"),
    [1435, 1446],
    "both numbers a squash subject carries are returned, in order",
  );
  eq(prNumbersInSubject("No references here"), [], "a subject with no reference asks about nothing");
  eq(
    prNumbersInSubject("Fix (#12)\n\nBody mentions (#999) and (#1000)"),
    [12],
    "only the SUBJECT is read: a squash body names every branch commit and would cost an API call each",
  );
  eq(prNumbersInSubject("Dupe (#7) and again (#7)"), [7], "a repeated reference is asked about once");
  eq(prNumbersInSubject("Zero (#0)"), [], "#0 is not a pull request, so it is not asked about");
  eq(prNumbersInSubject(""), [], "an empty message is handled rather than throwing");
}

finish();

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
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  BYPASS_MARKER,
  classifyPush,
  commitSubject,
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

// #4096 (L801): the marker is read from the SUBJECT only. A squash merge's body is every
// commit message on the branch, so a branch that merely MENTIONS the marker (a change to
// this guard or its docs, as #1069's own squash did) would otherwise exempt its red merge.
const mentionedInBody = {
  ...mergedRed,
  commitMessage: `Explain the hotfix escape hatch (#42)\n\n* Document that a direct push carries ${BYPASS_MARKER}`,
};
assert(!classifyPush(mentionedInBody).ok, "a red merge whose body only mentions the marker is still flagged");
const bodyOnlyDirect = { ...directPush, commitMessage: `Hotfix main\n\n${BYPASS_MARKER}` };
assert(!classifyPush(bodyOnlyDirect).ok, "a direct push with the marker only in its body is not a bypass");
eq(commitSubject(`Hotfix main\n\n${BYPASS_MARKER}`), "Hotfix main", "commitSubject keeps the first line only");
eq(commitSubject("One line, no body"), "One line, no body", "commitSubject of a one line message is the whole message");
eq(commitSubject(""), "", "commitSubject of an empty message is empty, never a throw");
const subjectMarked = { ...directPush, commitMessage: `Hotfix main ${BYPASS_MARKER}\n\nWhy: the booker is down.` };
assert(classifyPush(subjectMarked).ok, "the marker in the subject still allows a deliberate direct push");

// An open (not merged) PR associated with the commit is NOT a legitimate merge.
const openOnly = { ...base, prs: [{ number: 42, merged: false, ciConclusion: "success" }] };
assert(!classifyPush(openOnly).ok, "violation: an associated but unmerged PR does not count as a merge");

// The alert names the actor and the short sha so a human can act fast.
const msg = buildViolationMessage(directPush, classifyPush(directPush));
assert(/someone/.test(msg) && /abcdef1/.test(msg), "violation message names the actor and short sha");
// It quotes the subject, never the body, through the same commitSubject the verdict reads.
const bodied = { ...directPush, commitMessage: "Hotfix the booker\n\nA long body line" };
const bodiedMsg = buildViolationMessage(bodied, classifyPush(bodied));
assert(/Hotfix the booker/.test(bodiedMsg) && !/A long body line/.test(bodiedMsg), "the alert quotes the subject only");
assert(/\(no message\)/.test(buildViolationMessage({ ...directPush, commitMessage: "" }, classifyPush(directPush))), "an empty message reads as (no message)");

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

// #1519: an UNREADABLE association is answered by the claim route, exactly as an
// empty one is.
//
// The claim route was written for the association coming back EMPTY, which is the
// flavour of failure the 2026-08-13 incident produced, and it sat below an early
// return for an association that could not be READ. On 2026-08-17 that endpoint
// began answering 403 to the workflow token, which is the harder failure and the
// one the second route exists for, and the guard fetched the proof, printed it to
// its own log, and threw it away. Every merge to main failed and paged, and no
// re-run could help.
//
// The association index is GitHub's DERIVED record; the pull request is the
// PRIMARY one. A route that can only be consulted when the derived index answers
// is not a fallback (L161).
{
  const blindWithClaim = {
    ...base,
    prs: [],
    prsReadable: false,
    claimedBy: [{ number: 1446, isMergeCommitOfThisPush: true, ciConclusion: "success" }],
  };
  const verdict = classifyPush(blindWithClaim);
  assert(verdict.ok, "a merged PR claiming this very commit answers an unreadable association");
  assert(!verdict.unverified, "and it is a real measurement, not an unverified one");
  assert(
    /1446/.test(verdict.reason),
    "the reason names the PR the proof came from",
  );
  // L65: the primary route is DOWN and the run must say so, or a guard running on
  // one leg is indistinguishable from a healthy one and nobody learns the 403 is
  // there.
  assert(
    /could not be read|unreadable/i.test(verdict.reason),
    "and says the association could not be read, so the degradation is visible",
  );
}

// It still FAILS CLOSED. The change stops the guard discarding proof it holds; it
// does not let an unproven push through. With no claim and nothing readable there
// is nothing to stand on, and the verdict is the unverified one as before.
{
  const blindNoClaim = { ...base, prs: [], prsReadable: false, claimedBy: [] };
  const verdict = classifyPush(blindNoClaim);
  assert(!verdict.ok, "#1436 still holds when the claim route has nothing either");
  assert(verdict.unverified, "reported as a check that could not run, not as a direct push");
  assert(/UNKNOWN/.test(verdict.reason), "and says so in those words");
}

// A claim that does NOT name this commit cannot rescue an unreadable association.
// The claim route's whole strength is that merge_commit_sha is written by GitHub,
// so a claim failing that test is worth exactly nothing.
{
  const blindWeakClaim = {
    ...base,
    prs: [],
    prsReadable: false,
    claimedBy: [{ number: 1446, isMergeCommitOfThisPush: false, ciConclusion: "success" }],
  };
  const verdict = classifyPush(blindWeakClaim);
  assert(!verdict.ok, "a PR merely NAMED in the subject rescues nothing");
  assert(verdict.unverified, "the association is still what could not be read");
}

// A RED merge is caught on this route too, so an unreadable association cannot be
// used to slip a failed CI past the gate.
{
  const blindRedClaim = {
    ...base,
    prs: [],
    prsReadable: false,
    claimedBy: [{ number: 1446, isMergeCommitOfThisPush: true, ciConclusion: "failure" }],
  };
  const verdict = classifyPush(blindRedClaim);
  assert(!verdict.ok, "a merged PR whose CI failed is refused whichever route found it");
  assert(!verdict.unverified, "and that is a measurement, not an inability to check");
  assert(/failing CI/.test(verdict.reason), "named as a red merge");
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

// --- #1524: the guard must not need a dependency install to speak ----------
//
// On 2026-08-17 run 32039856279 died at `Failed to download action
// 'pnpm/action-setup'` with a 429 after three retries, so the only control over main
// never ran at all. Its whole job is to be the thing that still works when something
// else has gone wrong, and it was carrying pnpm, setup-node and a full
// `pnpm install --frozen-lockfile` purely to send one Slack message: the chain was
// `postSlack` -> `defaultAlertsChannel` -> `supabaseAdmin` -> @supabase/supabase-js.
{
  // Strip comment lines before matching. The workflow now EXPLAINS why it carries no
  // install, so a match on the raw text is answered by the comment describing the thing
  // rather than by the thing (L103), in the direction that fails a correct file. The
  // stripped copy is what every "must not contain" assertion below reads.
  const code = wf
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert(
    !/pnpm install/.test(code),
    "the workflow does not install dependencies (every one is another way for the guard to be unavailable)",
  );
  assert(
    !/pnpm\/action-setup/.test(code),
    "the workflow does not download the pnpm action, which is what took it out",
  );
  // The classification is pure and the poster is dependency free, so the `@/` alias
  // hook is not needed either. Asserted because leaving it in the command line is
  // harmless but hides that the guard could stop being self-contained.
  assert(
    !/register-paths/.test(code),
    "the workflow does not need the module alias hook, so nothing under src/ is reachable from the guard",
  );
}

// The strong version of the same claim, run rather than read: invoke the runner the
// way the workflow does, on bare node with NO alias hook. Any surviving `@/` import
// would fail to resolve and this would exit non-zero, so it proves the guard is
// self-contained instead of asserting it from the shape of an import line (L1).
{
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(ROOT, "scripts", "check-main-push.ts")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HEAD_SHA: "abcdef1234567890",
        COMMIT_MESSAGE: "Add a thing (#42)",
        ACTOR: "someone",
        RUN_URL: "https://github.com/Try-Pennie/slate/actions/runs/1",
        PRS_JSON: JSON.stringify([{ number: 42, merged: true, ciConclusion: "success" }]),
        MERGE_CLAIMS_JSON: "",
        PRS_READ_ERROR: "",
        GITHUB_OUTPUT: "",
        // Deliberately absent: a legitimate push posts nothing, so this must pass
        // with no Slack credentials at all.
        SLACK_BOT_TOKEN: "",
        SLACK_ALERTS_CHANNEL: "",
      },
    },
  );
  eq(res.status, 0, "the runner exits 0 on a legitimate merge with no dependencies installed");
  assert(
    /legitimate/i.test(`${res.stdout}${res.stderr}`),
    "and reports the merge it recognised",
  );
  assert(
    !/Cannot find package|ERR_MODULE_NOT_FOUND/.test(`${res.stdout}${res.stderr}`),
    "and resolves every import on bare node, with no alias hook and no node_modules reachable from it",
  );
}

// --- #1523: an infrastructure failure must not be silent -------------------
//
// The Slack alert was posted from the FINAL step, so every step before it (checkout,
// the action downloads, the install) could fail with the run going red and NOTHING
// sent anywhere. That is the same blind spot as #1519 one level up: there the guard
// could not reach a verdict, here it could not reach the step that speaks.
{
  assert(
    /if:\s*failure\(\)/.test(wf),
    "the workflow has a step that runs when an earlier step failed",
  );
  // It must survive the failure it is reporting, so it cannot depend on the install
  // having run. curl is on the runner image; a node script or an action is not
  // guaranteed to be reachable in the conditions this step exists for.
  // Slice from the marker, and fall back to the WHOLE file when it is absent, because
  // `slice(-1)` on a missing marker leaves one character and every assertion below
  // passes on nothing at all (L100: a match that found nothing reads as a pass).
  const failureAt = wf.indexOf("if: failure()");
  const failureStep = failureAt >= 0 ? wf.slice(failureAt) : wf;
  assert(
    /curl/.test(failureStep),
    "and posts with plain curl rather than anything the failed steps had to provide",
  );
  assert(
    !/uses:/.test(failureStep),
    "and downloads no action of its own, since an action download is what took the guard out",
  );
  assert(
    /RUN_URL|github\.run_id/.test(failureStep),
    "and carries the run URL, which is the one actionable thing it can offer",
  );
  // Three states, not two: a clean pass, a real violation (which the guard itself
  // alerts about), and an infrastructure failure. Without the gate a violation
  // double-posts, and two alerts about one commit is how a reader learns to skim.
  assert(
    /steps\.classify\.outputs\.handled/.test(wf),
    "and is gated on the guard not having already spoken, so a real violation is reported once",
  );
  assert(
    /id:\s*classify/.test(wf),
    "which requires the classify step to carry that id",
  );
}

// The marker behind that gate. It must mean "the guard reached a verdict AND said
// so", never merely "the script started": a violation whose Slack post failed has
// told nobody, and that is exactly when the curl route has to fire.
{
  const outFile = join(tmpdir(), `main-push-handled-${process.pid}.txt`);
  const readMarker = () => {
    try {
      return readFileSync(outFile, "utf8");
    } catch {
      return "";
    }
  };

  rmSync(outFile, { force: true });
  await run(async () => ({ ok: true }), {
    ...envFor(base),
    GITHUB_OUTPUT: outFile,
  });
  assert(/handled=true/.test(readMarker()), "a legitimate push records that the guard handled it");

  rmSync(outFile, { force: true });
  await run(async () => ({ ok: true }), {
    ...envFor(directPush),
    GITHUB_OUTPUT: outFile,
  });
  assert(
    /handled=true/.test(readMarker()),
    "a violation WITH a delivered alert also records it, so the curl route stays quiet",
  );

  rmSync(outFile, { force: true });
  await run(async () => ({ ok: false, error: "channel_not_found" }), {
    ...envFor(directPush),
    GITHUB_OUTPUT: outFile,
  });
  eq(
    readMarker(),
    "",
    "a violation whose alert did NOT send records nothing, so the curl route speaks for it",
  );

  // A missing GITHUB_OUTPUT (any local run) must not turn into a crash that fails
  // the guard for a reason unrelated to the push.
  let threw = false;
  try {
    await run(async () => ({ ok: true }), { ...envFor(base), GITHUB_OUTPUT: "" });
  } catch {
    threw = true;
  }
  assert(!threw, "no GITHUB_OUTPUT is handled rather than throwing");

  rmSync(outFile, { force: true });
}

finish();

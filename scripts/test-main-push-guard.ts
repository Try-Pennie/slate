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
  type PushContext,
} from "./lib/main-push-guard.ts";
import { run, readContextFromEnv, type PostFn } from "./check-main-push.ts";

const base: PushContext = {
  headSha: "abcdef1234567890",
  commitMessage: "Add a thing (#42)",
  actor: "someone",
  runUrl: "https://github.com/Try-Pennie/slate/actions/runs/1",
  prs: [{ number: 42, merged: true, ciConclusion: "success" }],
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

finish();

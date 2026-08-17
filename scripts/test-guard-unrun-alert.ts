// #1523: the main-push guard's LAST RESORT alert, driven with a fake curl.
//
// A last-resort alert nobody has watched work is not a last resort. This is the thing that
// speaks when the guard itself could not run, so it is the one part of the design that has
// no second route behind it, and it fires only in conditions nobody can reproduce on
// demand (a rate limited action download during a GitHub incident). So it is exercised
// here with a fake `curl` on PATH: no remote, no Slack, no push to main, exactly the way
// scripts/test-commit-pulls-retry.ts drives read-commit-pulls.sh.
//
// The case that matters most is the third one. Slack answers HTTP 200 with
// {"ok":false,...} for a bad channel, a revoked token and a rate limit, and curl's own
// failure text quotes the URL it was given, so any check looking for "slack" or for the
// channel id in the output is satisfied by the ERROR about it and reports success hardest
// at the moment it failed (L156).
//
// WHY IT IS EXTRACTED FROM THE YAML rather than imported from scripts/: the alert must not
// need any earlier step to have succeeded, and the checkout is an earlier step, so a script
// living in the repository cannot run when the thing that failed was fetching the
// repository. That forces the shell inline, and inline shell is normally shell nothing
// exercises. So this test lifts the exact block out of the workflow and runs it. The
// extraction asserts it found a real script first, because a slice that matched nothing
// would make every assertion below pass on an empty file (L100).
//
// Run: node --experimental-strip-types scripts/test-guard-unrun-alert.ts
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "main-push-guard.yml");
const wf = readFileSync(WORKFLOW, "utf8");

/**
 * Lift the `run:` body of the `if: failure()` step out of the workflow.
 *
 * Hand-rolled rather than done with a YAML parser because there is no yaml dependency in
 * this repo and the node suite must stay dependency free. It is deliberately strict: the
 * assertions below prove the extraction actually found the script, so this can never
 * silently hand back an empty string and turn the whole file green on nothing.
 */
function extractFailureStepScript(): string {
  const at = wf.indexOf("if: failure()");
  if (at < 0) return "";
  const after = wf.slice(at);
  const runAt = after.indexOf("run: |");
  if (runAt < 0) return "";
  const lines = after.slice(runAt).split("\n").slice(1);
  const body: string[] = [];
  for (const line of lines) {
    // A blank line belongs to the block; a non-indented one ends it.
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (!line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

const SCRIPT_BODY = extractFailureStepScript();

// Prove the extraction worked BEFORE anything runs against it. An empty or stub body would
// otherwise satisfy every "did not claim success" assertion in this file for the wrong
// reason (L100, L159).
assert(SCRIPT_BODY.length > 200, "the failure step's shell was extracted from the workflow");
assert(/chat\.postMessage/.test(SCRIPT_BODY), "and it is the block that posts to Slack");
assert(/jq -e/.test(SCRIPT_BODY), "and it decides success from Slack's own ok field");

const SCRIPT = join(mkdtempSync(join(tmpdir(), "guard-unrun-src-")), "alert.sh");
writeFileSync(SCRIPT, SCRIPT_BODY);

/**
 * Run the script with a fake `curl` that prints `stdout` and exits `code`.
 *
 * The fake also records the payload it was handed, so the test can assert on what would
 * really have been sent rather than only on what the script decided afterwards.
 */
function runWith(
  curl: { stdout: string; code: number },
  env: Record<string, string> = {},
): { status: number; out: string; sent: string } {
  const dir = mkdtempSync(join(tmpdir(), "guard-unrun-"));
  const capture = join(dir, "sent.txt");
  const fake = join(dir, "curl");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash\n` +
      // Record every argument, so the assertions can read the JSON body.
      `printf '%s\\n' "$@" > ${JSON.stringify(capture)}\n` +
      `printf '%s' ${JSON.stringify(curl.stdout)}\n` +
      `exit ${curl.code}\n`,
  );
  chmodSync(fake, 0o755);

  const res = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      // The fake curl comes FIRST on PATH; the rest of the path stays so jq is reachable.
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      RUN_URL: "https://github.com/Try-Pennie/slate/actions/runs/32039856279",
      HEAD_SHA: "0000a0d",
      ACTOR: "dwright",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_ALERTS_CHANNEL: "C09F4L6PLQP",
      ...env,
    },
  });
  let sent = "";
  try {
    sent = readFileSync(capture, "utf8");
  } catch {
    sent = "";
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}`, sent };
}

// --- Slack accepted it ----------------------------------------------------
{
  const r = runWith({ stdout: '{"ok":true,"channel":"C09F4L6PLQP","ts":"1.2"}', code: 0 });
  assert(/::notice::/.test(r.out), "a delivered alert reports as delivered");
  assert(!/::error/.test(r.out), "and raises no error about the send");
  // Red anyway: the push was never checked, which is the whole reason this ran.
  eq(r.status, 1, "the run still fails, because the push was not checked");

  // What would actually have been sent.
  assert(/chat\.postMessage/.test(r.sent), "it posts to chat.postMessage");
  assert(/C09F4L6PLQP/.test(r.sent), "to the configured channel");
  assert(/0000a0d/.test(r.sent), "naming the commit that was not checked");
  assert(/32039856279/.test(r.sent), "and carrying the run URL, the one actionable thing it has");
  assert(
    /never checked|could not run/i.test(r.sent),
    "and saying the guard could not run rather than accusing the commit",
  );
  assert(
    !/revert/i.test(r.sent),
    "and never telling the reader to revert, which cannot fix an infrastructure failure (L111)",
  );
  assert(
    !/Bearer/.test(r.sent.split("\n").filter((l) => l.startsWith("{")).join("")),
    "and never puts the token in the message body",
  );
}

// --- Slack answered 200 with ok:false -------------------------------------
{
  const r = runWith({ stdout: '{"ok":false,"error":"channel_not_found"}', code: 0 });
  assert(
    /::error title=main-push guard could not alert/.test(r.out),
    "an HTTP 200 carrying ok:false is NOT treated as delivered",
  );
  assert(/channel_not_found/.test(r.out), "and Slack's own reason reaches the log");
  assert(/unguarded/.test(r.out), "and the log says main is unguarded for this commit");
  eq(r.status, 1, "and the run fails");
}

// --- curl itself failed ---------------------------------------------------
{
  // The exact shape that defeats a substring check: curl's error text quotes the URL, so
  // it CONTAINS "slack.com". A check for that would call this a success.
  const r = runWith({
    stdout: 'curl: (6) Could not resolve host: slack.com',
    code: 6,
  });
  assert(
    /::error title=main-push guard could not alert/.test(r.out),
    "a curl failure whose error text quotes slack.com is not mistaken for a delivered alert (L156)",
  );
  assert(/Could not resolve host/.test(r.out), "and the cause reaches the log");
  eq(r.status, 1, "and the run fails");
}

// --- Slack returned an HTML error page ------------------------------------
{
  const r = runWith({ stdout: "<html><title>502 Bad Gateway</title></html>", code: 22 });
  assert(
    /::error title=main-push guard could not alert/.test(r.out),
    "an unparseable body is not mistaken for a delivered alert",
  );
  eq(r.status, 1, "and the run fails");
}

// --- the credentials are not configured -----------------------------------
{
  // #1500: an unset repo variable interpolates to "" rather than failing, so this is the
  // real shape of a missing one, not a hypothetical.
  const noToken = runWith({ stdout: '{"ok":true}', code: 0 }, { SLACK_BOT_TOKEN: "" });
  assert(/SLACK_BOT_TOKEN/.test(noToken.out), "a missing token names the token");
  eq(noToken.status, 1, "and fails the run");
  assert(!/::notice::/.test(noToken.out), "and never claims it told anybody");

  const noChannel = runWith({ stdout: '{"ok":true}', code: 0 }, { SLACK_ALERTS_CHANNEL: "" });
  assert(
    /SLACK_ALERTS_CHANNEL/.test(noChannel.out),
    "a missing channel names the channel, distinctly from a missing token (L11)",
  );
  eq(noChannel.status, 1, "and fails the run");

  const neither = runWith(
    { stdout: '{"ok":true}', code: 0 },
    { SLACK_BOT_TOKEN: "", SLACK_ALERTS_CHANNEL: "" },
  );
  assert(
    /SLACK_BOT_TOKEN/.test(neither.out) && /SLACK_ALERTS_CHANNEL/.test(neither.out),
    "with BOTH named when both are missing, not just the first (the monitorSetupGates rule)",
  );
}

// --- the guard's own alert is not a second copy of the violation wording -----
{
  const code = wf
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  // The classify step still owns the violation alert; this step must not try to classify
  // anything or repeat that wording, or the two would drift into disagreeing about the
  // same commit.
  // Strip the shell's own comments first: it EXPLAINS why it does not say "revert", and a
  // match on the raw text is answered by that explanation rather than by the message
  // (L103), in the direction that fails a correct file.
  const shell = SCRIPT_BODY.split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert(
    !/revert/i.test(shell),
    "the infrastructure alert never repeats the violation advice",
  );
  assert(
    /steps\.classify\.outputs\.handled/.test(code),
    "and it is gated on the guard not having already spoken",
  );
  // curl and jq only: anything the failed steps had to provide is unavailable exactly
  // when this step matters.
  assert(
    !/\bnode\b/.test(shell) && !/pnpm/.test(shell),
    "and it needs neither node nor pnpm, so it survives a failed setup or install",
  );
  assert(
    !/scripts\//.test(shell),
    "and reads nothing out of the repository, so it survives a failed checkout too",
  );
}

finish();

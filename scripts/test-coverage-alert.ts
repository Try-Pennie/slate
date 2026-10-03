// The nightly coverage run tells a person on a regressed or unmeasured verdict (#3101).
//
// Drives the decision (scripts/lib/coverage-alert.ts) and the alerter
// (scripts/notify-coverage.ts) with hand written verdict files and a fake poster, and
// checks coverage.yml runs the alerter whatever the coverage step exited with.
//
// Run: node --experimental-strip-types scripts/test-coverage-alert.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideCoverageAlert } from "./lib/coverage-alert.ts";
import { run, VERDICT_PATH } from "./notify-coverage.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { assertHouseStyle, HOUSE_STYLE_CHECKS } from "./lib/alerter-contract.ts";

const URL = "https://github.com/Try-Pennie/slate/actions/runs/7";
const file = (statements: string, branches: string) =>
  JSON.stringify({
    statements: { verdict: statements, message: `statements coverage is 80.00% (${statements})` },
    branches: { verdict: branches, message: `branches coverage is 70.00% (${branches})` },
  });

// --- quiet: nothing to act on tonight ------------------------------------------------
eq(decideCoverageAlert(file("pass", "pass"), URL).alert, null, "both metrics holding says nothing");
eq(decideCoverageAlert(file("raise", "pass"), URL).alert, null, "a gain asking for a raise says nothing either");

// --- a regression pages, naming the metric and its numbers --------------------------
{
  const a = decideCoverageAlert(file("pass", "regressed"), URL).alert ?? "";
  assert(/fell below its floor/.test(a), "a regression says coverage fell below its floor");
  assert(/branches coverage is 70\.00% \(regressed\)/.test(a), "with the ratchet's own message for that metric");
  assert(!/statements coverage/.test(a), "and not the metric that held");
  assert(a.includes(URL), "and the run link");
  eq(assertHouseStyle(assert, a, "regression message"), HOUSE_STYLE_CHECKS, "house style held");
}

// --- unmeasured is never a pass (L98) and never a regression claim (L11) ------------
{
  const none = decideCoverageAlert(null, URL);
  assert(none.alert !== null, "no verdict file at all pages");
  assert(/could not measure/.test(none.alert ?? "") && /ended before it wrote a verdict/.test(none.alert ?? ""), "as a run that died before judging");
  assert(!/fell below/.test(none.alert ?? ""), "without claiming a regression");

  const garbled = decideCoverageAlert("{not json", URL);
  assert(/could not be read/.test(garbled.alert ?? ""), "an unreadable verdict file pages on its own reason");

  const one = decideCoverageAlert(file("unmeasured", "pass"), URL);
  assert(/could not measure/.test(one.alert ?? "") && /statements/.test(one.alert ?? ""), "one unmeasured metric pages, naming it");

  const missing = decideCoverageAlert(JSON.stringify({ statements: { verdict: "pass", message: "x" } }), URL);
  assert(/branches was never judged/.test(missing.alert ?? ""), "a metric missing from the file was never judged, not passed");

  const both = decideCoverageAlert(file("regressed", "unmeasured"), URL).alert ?? "";
  assert(/fell below/.test(both) && /Also not measured: branches/.test(both), "a regression and an unmeasured metric are both said");
}

// --- the alerter ----------------------------------------------------------------------
{
  const posts: { text: string; channel?: string }[] = [];
  const post = async (m: { text: string; channel?: string }) => {
    posts.push(m);
    return { ok: true };
  };
  const env = { RUN_URL: URL, SLACK_ALERTS_CHANNEL: "C9" };
  eq((await run(post, env, () => file("pass", "pass"))).code, 0, "a holding night exits 0");
  eq(posts.length, 0, "and posts nothing");
  eq((await run(post, env, () => file("regressed", "pass"))).code, 1, "a regression stays red once posted");
  eq(posts.length, 1, "posted exactly once");
  eq(posts[0]?.channel, "C9", "to the configured channel");
  const unsent = await run(async () => ({ ok: false, error: "slack-channel-not-configured" }), { RUN_URL: URL }, () => null);
  eq(unsent.code, 1, "an undelivered alert is red");
  assert(/slack-channel-not-configured/.test(unsent.reason), "and says why");
}

// --- wired, not merely written (L3) ---------------------------------------------------
{
  const root = join(import.meta.dirname, "..");
  const wf = readFileSync(join(root, ".github", "workflows", "coverage.yml"), "utf8");
  const step = wf.split(/^ {6}- /m).find((s) => /run: node [^\n]*scripts\/notify-coverage\.ts/.test(s)) ?? "";
  assert(step.length > 0, "coverage.yml runs the coverage alerter");
  assert(/^\s*if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}\s*$/m.test(step), "whatever the coverage step exited with, but NOT on a cancelled run");
  assert(!/always\(\)/.test(step), "never always(): cancel-in-progress cancels a superseded run, which would then page that it could not measure (L36, L671)");
  assert(/SLACK_BOT_TOKEN:\s*\$\{\{\s*secrets\.SLACK_BOT_TOKEN\s*\}\}/.test(step), "with the Slack token");
  assert(/RUN_URL:/.test(step), "and the run link");
  const runner = readFileSync(join(root, "scripts", "coverage.mjs"), "utf8");
  assert(runner.includes(VERDICT_PATH.split("/").pop()!), "and coverage.mjs writes the verdict file the alerter reads");
}

finish();

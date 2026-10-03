// #122: the deploy-failure alert workflow must fire a Slack alert when a CI run
// FAILS on a push to main. A silently non-updating live site (a billing freeze,
// a transient Cloudflare error) otherwise goes unnoticed until someone checks CI
// by hand. This guards the wiring: right trigger, gated to a failed main push,
// wired to the notifier script with the Slack creds and run context.
//
// Run: node --experimental-strip-types scripts/test-deploy-failure-alert.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wf = readFileSync(
  resolve(repoRoot, ".github/workflows/deploy-alert.yml"),
  "utf8",
);

// Triggered by the CI workflow completing (workflow_run), so it sees the whole
// run's conclusion, not just one step.
assert(/workflow_run:/.test(wf), "triggers on workflow_run");
assert(/workflows:\s*\[?[^\]\n]*\bCI\b/.test(wf), "keys off the CI workflow");
assert(/types:\s*\[?[^\]\n]*\bcompleted\b/.test(wf), "runs on completion");

// Gate: only a FAILED run, only on main, only a push (ignore PR runs).
assert(
  /workflow_run\.conclusion == 'failure'/.test(wf),
  "alerts only on a failed run",
);
assert(
  /workflow_run\.head_branch == 'main'/.test(wf),
  "alerts only for main",
);
assert(
  /workflow_run\.event == 'push'/.test(wf),
  "alerts only for a push run (ignores PR runs)",
);

// Wired to the notifier script with the Slack creds and failed-run context.
assert(
  /scripts\/notify-deploy-failure\.ts/.test(wf),
  "runs the notify-deploy-failure script",
);
assert(
  /SLACK_BOT_TOKEN:\s*\$\{\{\s*secrets\.SLACK_BOT_TOKEN\s*\}\}/.test(wf),
  "passes the Slack bot token secret",
);
assert(
  /SLACK_ALERTS_CHANNEL:\s*\$\{\{\s*vars\.SLACK_ALERTS_CHANNEL\s*\}\}/.test(wf),
  "passes the alerts channel variable",
);
// #3087: the message names the failed jobs, because a red security scan on main
// fails the run without holding back the deploy, and "deploy failed" would then be
// false. The jobs are read from the run, with a token allowed to read them, and a
// read that fails becomes `unknown` rather than an empty list, so the notifier falls
// back to the generic message instead of reading silence as "nothing failed".
assert(/FAILED_JOBS:\s*\$\{\{\s*steps\.[\w-]+\.outputs\.failed\s*\}\}/.test(wf), "passes the failed jobs to the notifier");
assert(/actions\/runs\/\$\{?RUN_ID\}?\/jobs/.test(wf), "reads them from the run's own jobs");
assert(/RUN_ID:\s*\$\{\{\s*github\.event\.workflow_run\.id\s*\}\}/.test(wf), "for the run that failed");
assert(/actions:\s*read/.test(wf), "with a token allowed to read Actions");
assert(/failed=unknown/.test(wf), "and a read that fails is recorded as unknown, not as no failures");

// #1598: it carries no dependency install. This alert fires exactly when CI on
// main has already failed, which correlates with GitHub or the network having a
// bad day, so every dependency it carries is another way for it to be
// unavailable in the conditions it exists for. #1524 made the same removal for
// the main push guard after a 429 downloading pnpm/action-setup left that guard
// unrun.
//
// Comment lines are stripped before matching, because the workflow now EXPLAINS
// why it carries no install and a match on the raw text would be answered by the
// sentence describing the thing rather than by the thing (L103), in the direction
// that fails a correct file.
//
// These assertions are about the WIRING only. Whether the script it runs still
// needs an install is a question about the script's imports, not about this file,
// and scripts/test-dependency-free-scripts.ts answers it by walking the real
// import graph (L63).
{
  const code = wf
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert(
    !/pnpm install/.test(code),
    "the workflow installs no dependencies to send one Slack message",
  );
  assert(
    !/pnpm\/action-setup/.test(code),
    "the workflow does not download the pnpm action, which is what took the sibling guard out",
  );
  assert(
    !/register-paths/.test(code),
    "the workflow does not need the module alias hook, so nothing under src/ is reachable from the alerter",
  );
  assert(
    /actions\/setup-node@/.test(code),
    "setup-node stays, so the node version the type stripping flag needs is pinned rather than inherited",
  );
}

assert(
  /RUN_URL:\s*\$\{\{\s*github\.event\.workflow_run\.html_url\s*\}\}/.test(wf),
  "passes the failed run URL",
);
assert(
  /COMMIT_SHA:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/.test(wf),
  "passes the commit sha",
);

finish();

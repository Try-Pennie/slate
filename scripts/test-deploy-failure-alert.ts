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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wf = readFileSync(
  resolve(repoRoot, ".github/workflows/deploy-alert.yml"),
  "utf8",
);

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
};

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
assert(
  /RUN_URL:\s*\$\{\{\s*github\.event\.workflow_run\.html_url\s*\}\}/.test(wf),
  "passes the failed run URL",
);
assert(
  /COMMIT_SHA:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/.test(wf),
  "passes the commit sha",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

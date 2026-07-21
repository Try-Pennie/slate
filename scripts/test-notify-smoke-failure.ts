// #525: unit-tests the smoke-failure Slack alerter's pure core, mirroring
// scripts/test-notify-deploy-failure.ts.
//
// - buildSmokeFailureMessage produces plain, dash-free, emoji-free copy that
//   names the pass (full vs dry) and links the failed run.
// - run() posts exactly once through the injected poster, honours
//   SLACK_ALERTS_CHANNEL, and FAILS LOUD (ok:false) when the post errors or Slack
//   is unconfigured, so a broken alerter goes visibly red rather than pretending
//   it warned anyone.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/test-notify-smoke-failure.ts
import {
  buildSmokeFailureMessage,
  readContextFromEnv,
  run,
} from "./notify-smoke-failure.ts";
import { assert, finish } from "./lib/harness.ts";

const runUrl = "https://github.com/Try-Pennie/slate/actions/runs/123";

// --- message builder: full and dry both name the pass and link the run ---
for (const [mode, needle] of [
  ["full", "full end to end"],
  ["dry", "health check"],
] as const) {
  const text = buildSmokeFailureMessage({ mode, runUrl });
  assert(text.includes(runUrl), `${mode}: message links to the failed run`);
  assert(text.toLowerCase().includes(needle), `${mode}: message names the pass`);
  assert(/canary failed/i.test(text), `${mode}: message says the canary failed`);
  // House style: no dashes as punctuation, no emoji (Slack shortcodes included).
  assert(
    !new RegExp("[\u2014\u2013]").test(text),
    `${mode}: no em or en dashes`,
  );
  assert(
    !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text),
    `${mode}: no unicode emoji`,
  );
  assert(!/:[a-z0-9_]+:/.test(text), `${mode}: no slack emoji shortcodes`);
}

// --- env reader maps both fields ---
const parsed = readContextFromEnv({ SMOKE_MODE: "full", RUN_URL: runUrl });
assert(
  parsed.mode === "full" && parsed.runUrl === runUrl,
  "readContextFromEnv maps mode and runUrl",
);

const baseEnv = { SMOKE_MODE: "full", RUN_URL: runUrl };

// --- run(): happy path posts once to the configured channel ---
{
  const calls: { text: string; channel?: string }[] = [];
  const post = async (m: { text: string; channel?: string }) => {
    calls.push(m);
    return { ok: true };
  };
  const res = await run(post, { ...baseEnv, SLACK_ALERTS_CHANNEL: "C123" });
  assert(res.ok, "run returns ok on a successful post");
  assert(calls.length === 1, "run posts exactly once");
  assert(calls[0]?.channel === "C123", "run posts to SLACK_ALERTS_CHANNEL");
}

// --- run(): a Slack API error FAILS LOUD ---
{
  let called = 0;
  const post = async () => {
    called++;
    return { ok: false, error: "channel_not_found" };
  };
  const res = await run(post, { ...baseEnv, SLACK_ALERTS_CHANNEL: "C123" });
  assert(!res.ok, "run FAILS LOUD when the Slack post errors");
  assert(/channel_not_found/.test(res.reason), "run surfaces the Slack error");
  assert(called === 1, "run attempted the post once");
}

// --- run(): unconfigured Slack FAILS LOUD (never silently no-ops) ---
{
  const post = async () => ({ ok: false, error: "slack-not-configured" });
  const res = await run(post, baseEnv);
  assert(!res.ok, "run FAILS LOUD when Slack is unconfigured");
  assert(
    /slack-not-configured/.test(res.reason),
    "run surfaces the unconfigured reason",
  );
}

finish();

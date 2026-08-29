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
import type { FailureLog, FailureLogIo } from "./lib/smoke-failure-log.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  assertAlerterFailsLoud,
  assertHouseStyle,
  FAIL_LOUD_CHECKS,
  HOUSE_STYLE_CHECKS,
} from "./lib/alerter-contract.ts";

/** No failure log configured: the shape every pre-#1492 assertion below assumes. */
const NO_LOG: FailureLog = { kind: "none" };
/** In-memory io so the env reader can be driven without a disk. */
const ioWith = (files: Record<string, string>): FailureLogIo => ({
  append: () => {},
  read: (path) => files[path] ?? null,
});

const runUrl = "https://github.com/Try-Pennie/slate/actions/runs/123";

// --- message builder: full and dry both name the pass and link the run ---
for (const [mode, needle] of [
  ["full", "full end to end"],
  ["dry", "health check"],
] as const) {
  const text = buildSmokeFailureMessage({ mode, runUrl, failures: NO_LOG });
  assert(text.includes(runUrl), `${mode}: message links to the failed run`);
  assert(text.toLowerCase().includes(needle), `${mode}: message names the pass`);
  assert(/canary failed/i.test(text), `${mode}: message says the canary failed`);
  // House style: no dashes as punctuation, no emoji (Slack shortcodes included).
  // The count is pinned so a helper that stopped asserting cannot read as a pass.
  assert(
    assertHouseStyle(assert, text, mode) === HOUSE_STYLE_CHECKS,
    `${mode}: the shared house-style check ran every one of its assertions`,
  );
}

// --- env reader maps both fields ---
const parsed = readContextFromEnv({ SMOKE_MODE: "full", RUN_URL: runUrl }, ioWith({}));
assert(
  parsed.mode === "full" && parsed.runUrl === runUrl,
  "readContextFromEnv maps mode and runUrl",
);

// --- #1492: the alert names WHICH checks failed ---
//
// The old message was one sentence covering every possible cause, so three pages in
// ten days for the same benign fixture collision could not be told from a real
// booking outage by reading Slack.
{
  const failures: FailureLog = {
    kind: "failures",
    lines: [
      "FAIL: rebook into bucket SMOKE2 -> new booking (got deduped)",
      "FAIL: book in bucket SMOKE -> created (got no_eligible_agents)",
    ],
  };
  const text = buildSmokeFailureMessage({ mode: "dry", runUrl, failures });
  assert(text.includes("2 checks failed"), `names how many failed (got: ${text})`);
  assert(text.includes("rebook into bucket SMOKE2"), "names the first failed check");
  assert(text.includes("no_eligible_agents"), "names the second, with its detail");
  assert(text.includes(runUrl), "and still links the run");
  // The old catch-all sentence must be gone, or the reader is back to guessing.
  assert(
    !/Either booking is broken/i.test(text),
    "the sentence that covered every possible cause is gone",
  );
  // The FAIL: prefix is redundant once the message says these are failed checks.
  assert(!/^-\s*FAIL:/m.test(text), "each line reads as prose, not as raw log output");

  const one = buildSmokeFailureMessage({
    mode: "dry",
    runUrl,
    failures: { kind: "failures", lines: ["FAIL: only this one"] },
  });
  assert(one.includes("1 check failed"), `singular reads correctly (got: ${one})`);
}
{
  // A broken deploy can fail every check. Thirty lines on a phone mid incident is the
  // #1133 wall of text, so the list is capped and the rest are pointed at.
  const many = Array.from({ length: 20 }, (_, i) => `FAIL: check number ${i} did not pass`);
  const text = buildSmokeFailureMessage({ mode: "full", runUrl, failures: { kind: "failures", lines: many } });
  assert(text.includes("20 checks failed"), "the TOTAL is still reported");
  assert(/and \d+ more in the run/.test(text), `and the remainder is pointed at (got: ${text})`);
  assert(text.split("\n").length < 12, `the message stays readable on a phone (${text.split("\n").length} lines)`);
}
{
  // A very long detail must not push the run link off screen, and must never be cut
  // mid word: #1133 shipped a line ending in "mess" and that is what made it
  // unreadable.
  const long = `FAIL: ${"a-detailed-reason ".repeat(40)}`;
  const text = buildSmokeFailureMessage({ mode: "full", runUrl, failures: { kind: "failures", lines: [long] } });
  assert(text.includes(runUrl), "the run link survives a very long detail");
  const line = text.split("\n").find((l) => l.startsWith("- "))!;
  assert(line.length < 200, `the line is truncated (${line.length} chars)`);
  assert(line.endsWith("..."), "and says it was truncated");
  // The detail is "a-detailed-reason " repeated, so a cut on a word boundary leaves a
  // COMPLETE token before the ellipsis. A mid-word cut would leave a fragment.
  const body = line.replace(/^- /, "").replace(/\.\.\.$/, "");
  assert(
    /a-detailed-reason$/.test(body.trimEnd()),
    `cut on a word boundary, leaving a whole word (ends with: ${JSON.stringify(body.slice(-24))})`,
  );
}
{
  // The state 2026-08-14 was actually in: the run threw before any check reported.
  // This must NOT read as a booking regression, and must not read as "nothing failed".
  const text = buildSmokeFailureMessage({ mode: "dry", runUrl, failures: { kind: "none" } });
  assert(
    /no check reported/i.test(text),
    `says no check reported a result (got: ${text})`,
  );
  assert(
    /crash|missing key|base URL/i.test(text),
    "and points at where to look instead of at booking",
  );
  assert(
    !/checks failed/i.test(text),
    "and never claims checks failed, which nothing measured",
  );
}
{
  // Unreadable is its own message: "could not read what failed" sends the reader
  // somewhere different from "no check reported" (L11).
  const text = buildSmokeFailureMessage({
    mode: "dry",
    runUrl,
    failures: { kind: "unreadable", reason: "EACCES: permission denied" },
  });
  assert(/could not be read/i.test(text), "says it could not read the failures");
  assert(text.includes("EACCES"), "and names the reason");
  assert(!/no check reported/i.test(text), "and is NOT the same message as none");
}

// --- the env reader really picks the log up ---
{
  const ctx = readContextFromEnv(
    { SMOKE_MODE: "dry", RUN_URL: runUrl, SMOKE_FAILURE_FILE: "f.txt" },
    ioWith({ "f.txt": "FAIL: one thing\nFAIL: another\n" }),
  );
  eq(ctx.failures.kind, "failures", "the configured log is read");
  eq(ctx.failures.kind === "failures" ? ctx.failures.lines.length : -1, 2, "with both lines");
}

const baseEnv = { SMOKE_MODE: "full", RUN_URL: runUrl };
const noIo = ioWith({});

// --- run(): the fail-loud contract, shared with the deploy alerter (#1596) ---
// Smoke is unconfigured by having no SLACK_ALERTS_CHANNEL.
{
  const ran = await assertAlerterFailsLoud(assert, {
    channel: "C123",
    configured: (post) => run(post, { ...baseEnv, SLACK_ALERTS_CHANNEL: "C123" }, noIo),
    unconfigured: (post) => run(post, baseEnv, noIo),
  });
  assert(ran === FAIL_LOUD_CHECKS, "the shared fail-loud contract ran every one of its assertions");
}

finish();

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
import { parseSmokeReport, SMOKE_REPORT_LIMITS } from "../src/lib/monitor/smoke-canary-failure.ts";
import { boundedReport, HANDOFF_LIMITS } from "./lib/smoke-failure-handoff.ts";
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

// --- #3801: hand the failure to the Worker first, post directly only if that fails ---
{
  const keyed = { ...baseEnv, SLACK_ALERTS_CHANNEL: "C123", BOOKING_API_KEY_CANARY: "k", SLATE_BASE_URL: "" };
  const logIo = ioWith({ "f.txt": "FAIL: availability read took 4210ms\n" });
  const envWithLog = { ...keyed, SMOKE_FAILURE_FILE: "f.txt" };
  const answering = (status: number, body: unknown) => {
    const calls: { url: string; body: string; auth: string }[] = [];
    const fetchFn = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, body: init.body, auth: init.headers.authorization ?? "" });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    return { calls, fetchFn };
  };
  const posts: string[] = [];
  const post = async (msg: { text: string }) => {
    posts.push(msg.text);
    return { ok: true };
  };

  for (const outcome of ["sent", "held"] as const) {
    posts.length = 0;
    const w = answering(200, { ok: true, outcome });
    const res = await run(post, envWithLog, logIo, w.fetchFn);
    eq(res.ok, true, `a Worker answer of ${outcome} is a handled alert`);
    eq(posts.length, 0, `and the step posts nothing itself when the Worker ${outcome} it`);
    eq(w.calls.length, 1, "the Worker was asked once");
    eq(w.calls[0].url, "https://slate.trypennie.app/api/smoke/failure", "at the default base when the variable is empty");
    eq(w.calls[0].auth, "Bearer k", "with the canary's own key");
    const sent = JSON.parse(w.calls[0].body) as { outcome: string; mode: string; text: string; checks: string[] };
    eq(sent.outcome, "failed", "as a failure");
    eq(sent.mode, "full", "of the pass that ran");
    eq(sent.checks, ["availability read took 4210ms"], "naming the failed checks without their log prefix");
    assert(sent.text.includes("availability read took 4210ms"), "carrying the message the step would have posted");
  }

  for (const [why, w] of [
    ["the Worker answering 503", answering(503, { error: "down" })],
    ["the Worker saying its own post failed", answering(200, { ok: true, outcome: "failed" })],
    ["the Worker saying it cannot post", answering(200, { ok: true, outcome: "skipped" })],
    ["an answer that is not JSON", answering(200, "not json")],
  ] as const) {
    posts.length = 0;
    const res = await run(post, envWithLog, logIo, w.fetchFn);
    eq(posts.length, 1, `${why} makes the step post directly`);
    assert(/posted directly/.test(res.reason), `and says so (${res.reason})`);
  }

  {
    posts.length = 0;
    const throwing = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const res = await run(post, envWithLog, logIo, throwing);
    eq(posts.length, 1, "a Worker that cannot be reached at all is posted around");
    assert(res.reason.includes("ENOTFOUND"), "naming why");
  }
  {
    posts.length = 0;
    const w = answering(200, { ok: true, outcome: "sent" });
    await run(post, { ...baseEnv, SLACK_ALERTS_CHANNEL: "C123" }, noIo, w.fetchFn);
    eq(w.calls.length, 0, "with no canary key the Worker is not asked");
    eq(posts.length, 1, "and the step posts directly, as before #3801");
  }
  {
    // A broken deploy fails many checks, and one slow read's detail can run long. The
    // Worker refuses a report past its limits, which would send EVERY such run around
    // the throttle as a direct post, so the handoff bounds what it sends to exactly what
    // the Worker's own parser accepts.
    posts.length = 0;
    const longLine = `availability read took 4210ms ${"and kept waiting ".repeat(40)}`;
    const manyIo = ioWith({
      "f.txt": Array.from({ length: 60 }, (_, i) => `FAIL: check ${i} ${longLine}`).join("\n") + "\n",
    });
    const w = answering(200, { ok: true, outcome: "sent" });
    await run(post, envWithLog, manyIo, w.fetchFn);
    eq(w.calls.length, 1, "a long many check failure is still handed to the Worker");
    const sent = JSON.parse(w.calls[0].body) as unknown;
    const parsed = parseSmokeReport(sent);
    eq(parsed.ok, true, `and the Worker's own parser accepts what was sent (${parsed.ok ? "ok" : parsed.error})`);
    eq(posts.length, 0, "so the step does not post around the throttle");
  }
  {
    // The bounds are restated on the bare node side, so they are held equal here.
    eq({ ...HANDOFF_LIMITS }, { ...SMOKE_REPORT_LIMITS }, "the handoff bounds what the Worker's parser accepts, no more and no less");
    const long = `${"x".repeat(5000)}\n${runUrl}`;
    const b = boundedReport({ text: long, checks: [] });
    assert(b.text.length <= HANDOFF_LIMITS.textChars, "an over long message is cut to the limit");
    assert(b.text.endsWith(`\n${runUrl}`), "keeping the link to the run");
  }
}

finish();

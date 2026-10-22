// #4062: the canary alert must say what the run RECORDED, and a crash is recorded.
//
// At 7:41 PM ET on 2026-10-21 (run 39694932888) the alert said "No check reported a
// result, so the run stopped before the checks began". That was false: the reschedule
// smoke had passed 4 checks and then crashed on a connect timeout. createChecker
// recorded only failures and the crash handler recorded nothing, so an empty failure
// file could not tell "never started" from "crashed after passing checks".
//
// Now each passing check appends a pass mark, a crash appends a crash line with a
// short reason, and the message builder gives each recorded state its own sentence:
//   (a) nothing recorded, (b) a crash after passes, (c) failed checks,
// plus the two in between: passes with no failure and no crash, and a crash beside
// failures.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/test-smoke-crash-record.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  readFailures,
  recordCrash,
  recordFailure,
  recordPass,
  type FailureLog,
  type FailureLogIo,
} from "./lib/smoke-failure-log.ts";
import { buildSmokeFailureMessage, smokeFailureChecks } from "./lib/smoke-failure-message.ts";
import { crashReason, recordSmokeCrash } from "./lib/smoke-crash.ts";
import { createChecker } from "./smoke-lib.ts";
import {
  RESCHEDULE_SMOKE_NAME,
  rescheduleSmokeExitCode,
  runRescheduleSmoke,
  type SmokePost,
} from "./lib/smoke-reschedule-run.ts";

function fakeIo(): FailureLogIo & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    append: (path, line) => {
      files[path] = (files[path] ?? "") + line;
    },
    read: (path) => files[path] ?? null,
  };
}

const runUrl = "https://github.com/Try-Pennie/slate/actions/runs/39694932888";
const message = (failures: FailureLog) => buildSmokeFailureMessage({ mode: "full", runUrl, failures });
/** The sentence after the head line, which is the part each state decides. */
const sentence = (text: string) => text.split("\n")[0]!.replace(/^Booking canary failed: [^.]*\.\s*/, "");

// --- recording: passes and a crash cross the file, and read back as a crash ---
const io = fakeIo();
const P = "smoke-failures.txt";
assert(recordPass(io, P), "a pass is recorded");
for (let i = 0; i < 3; i++) recordPass(io, P);
assert(recordCrash(io, P, "The reschedule smoke", "the connection timed out"), "a crash is recorded");
eq(recordPass(io, null), false, "with no path, recording a pass is a no-op");
eq(recordCrash(io, null, "x", "y"), false, "with no path, recording a crash is a no-op");
const crashed = readFailures(io, P);
eq(crashed.kind, "crashed", "4 passes then a crash read back as crashed, never as none");
if (crashed.kind === "crashed") {
  eq(crashed.passed, 4, "with the 4 passes counted");
  eq(crashed.crashes.length, 1, "and one crash");
  eq(crashed.crashes[0]?.where, "The reschedule smoke", "naming the smoke that crashed");
  eq(crashed.crashes[0]?.reason, "the connection timed out", "and its reason");
  eq(crashed.crashes[0]?.passedBefore, 4, "and how many checks had passed before it");
}
// A crash reason holding a newline is still ONE crash line.
{
  const io2 = fakeIo();
  recordCrash(io2, P, "The booking smoke", "first line\n    at stack frame");
  const log = readFailures(io2, P);
  eq(log.kind === "crashed" ? log.crashes.length : -1, 1, "a multi line reason is one crash");
}
// Passes only: the run stopped with no failure and no crash recorded.
{
  const io3 = fakeIo();
  recordPass(io3, P);
  recordPass(io3, P);
  const log = readFailures(io3, P);
  eq(log.kind, "stopped", "passes alone read as stopped");
  eq(log.kind === "stopped" ? log.passed : -1, 2, "with the passes counted");
}
// Failures beside passes and a crash: still failures, carrying both.
{
  const io4 = fakeIo();
  recordPass(io4, P);
  recordFailure(io4, P, "FAIL: create -> 200 created (got 409 confirm_required)");
  recordCrash(io4, P, "The reschedule smoke", "the connection was reset");
  const log = readFailures(io4, P);
  eq(log.kind, "failures", "a failed check keeps the failures state");
  if (log.kind === "failures") {
    eq(log.lines.length, 1, "the pass and crash marks are not read as failed checks");
    eq(log.passed, 1, "the pass is counted");
    eq(log.crashes?.length, 1, "the crash is carried");
  }
}

// --- the message: one distinct sentence per recorded state (the issue's Done when) ---
const none = sentence(message({ kind: "none" }));
const afterPasses = sentence(message(crashed));
const failedChecks = sentence(
  message({ kind: "failures", lines: ["FAIL: create -> 200 created (got 409 confirm_required)"] }),
);
const stopped = sentence(message({ kind: "stopped", passed: 5 }));
const crashedFirst = sentence(
  message({
    kind: "crashed",
    passed: 0,
    crashes: [{ where: "The booking smoke", reason: "the host name did not resolve", passedBefore: 0 }],
  }),
);
console.log(`  (a) ${none}\n  (b) ${afterPasses}\n  (c) ${failedChecks}\n  stopped: ${stopped}\n  first: ${crashedFirst}`);

eq(
  afterPasses,
  "The reschedule smoke crashed after 4 checks passed: the connection timed out.",
  "(b) a crash after passes says so, with the count and the reason",
);
assert(!/stopped before the checks began/i.test(afterPasses), "(b) never says the checks had not begun");
eq(none, "No check reported a result and no crash was recorded. Open the run log.", "(a) nothing recorded says only that");
assert(/^1 check failed:/.test(failedChecks), `(c) failed checks are counted and named (got: ${failedChecks})`);
eq(
  stopped,
  "5 checks passed, then the run stopped without recording a failure or a crash. Open the run log.",
  "passes alone say the run stopped unrecorded",
);
eq(
  crashedFirst,
  "The booking smoke crashed before any check passed: the host name did not resolve.",
  "a crash with no pass before it says so",
);
eq(new Set([none, afterPasses, failedChecks, stopped, crashedFirst]).size, 5, "every state reads differently");
eq(
  sentence(message({ kind: "crashed", passed: 1, crashes: [{ where: "The booking smoke", reason: "x", passedBefore: 1 }] })),
  "The booking smoke crashed after 1 check passed: x.",
  "one pass is singular",
);
{
  const both = message({
    kind: "failures",
    lines: ["FAIL: create -> 200 created (got 409 confirm_required)"],
    passed: 1,
    crashes: [{ where: "The reschedule smoke", reason: "the connection was reset", passedBefore: 1 }],
  });
  assert(
    both.includes("The reschedule smoke also crashed: the connection was reset."),
    `failures beside a crash name the crash too (got: ${both})`,
  );
}
{
  const two = sentence(
    message({
      kind: "crashed",
      passed: 3,
      crashes: [
        { where: "The booking smoke", reason: "a", passedBefore: 3 },
        { where: "The reschedule smoke", reason: "b", passedBefore: 3 },
      ],
    }),
  );
  assert(/The booking smoke crashed after 3 checks passed: a\./.test(two), "the first crash leads");
  assert(/The reschedule smoke also crashed: b\./.test(two), "a second crash is named too");
}
// One line each: the head and its sentence never wrap into a paragraph.
for (const t of [message({ kind: "none" }), message(crashed), message({ kind: "stopped", passed: 5 })]) {
  eq(t.split("\n").length, 2, "the message is one line plus the run link");
}

// --- the subjects the Worker throttles on: a crash is its own, stable, subject ---
eq(smokeFailureChecks(crashed), ["the reschedule smoke crashed"], "a crash is one subject naming the smoke");
eq(smokeFailureChecks({ kind: "stopped", passed: 5 }), ["the run stopped without a record"], "stopped is its own subject");
eq(smokeFailureChecks({ kind: "none" }), ["no check reported a result"], "none keeps its subject");

// --- the crash reason: plain words for the network failures the runner meets ---
const net = (code: string) => {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(new Error(`connect ${code} 1.2.3.4:443`), { code });
  return err;
};
eq(crashReason(net("ETIMEDOUT")), "the connection timed out", "ETIMEDOUT in words");
eq(crashReason(net("UND_ERR_CONNECT_TIMEOUT")), "the connection timed out", "undici's connect timeout in words");
eq(crashReason(net("ECONNRESET")), "the connection was reset", "ECONNRESET in words");
eq(crashReason(net("ECONNREFUSED")), "the connection was refused", "ECONNREFUSED in words");
eq(crashReason(net("ENOTFOUND")), "the host name did not resolve", "ENOTFOUND in words");
eq(crashReason(net("EWHATEVER")), "fetch failed (EWHATEVER)", "an unknown code keeps the code");
// An inherited object key is not a known code: the reason is still a string.
eq(crashReason(net("constructor")), "fetch failed", "a code named like an inherited key is not looked up");
eq(typeof crashReason(net("toString")), "string", "the reason is always a string");
eq(crashReason(new Error("boom\n    at frame (file.ts:1:1)")), "boom at frame (file.ts:1:1)", "a stack is one line");
assert(!crashReason(new Error("x".repeat(500))).includes("x".repeat(300)), "a long message is cut short");

// --- the incident end to end: the real run, checker and crash recorder on one log ---
{
  const log = fakeIo();
  const env = { SMOKE_FAILURE_FILE: P };
  const { check, failed } = createChecker({ io: log, env });
  const slots = Array.from({ length: 19 }, (_, i) => new Date(Date.UTC(2026, 9, 21, 23, i * 10)).toISOString());
  let calls = 0;
  const post: SmokePost = async (path, body) => {
    calls += 1;
    // Create, then one reschedule; from the concurrent pair on the connect times out,
    // the teardown cancel included, as in run 39694932888.
    if (calls > 2) throw net("ETIMEDOUT");
    if (path === "/api/bookings") {
      return { status: 200, body: { outcome: "created", booking: { id: "98c0e697", manageUrl: "https://x/booking/manage/tok" } } };
    }
    return { status: 200, body: { startsAt: body.start } };
  };
  let exitCode: number | null = null;
  try {
    await runRescheduleSmoke({ bucket: "SMOKE", nonce: 1, post, slots: async () => slots, check, sleep: async () => {}, log: () => {} });
  } catch (err) {
    recordSmokeCrash(RESCHEDULE_SMOKE_NAME, err, env, log);
    exitCode = rescheduleSmokeExitCode("crashed", failed());
  }
  eq(exitCode, 1, "the crashed run exits 1");
  const recorded = readFailures(log, P);
  const text = message(recorded);
  console.log(`  incident: ${text.replace(/\n/g, " | ")}`);
  assert(!/No check reported a result/.test(text), "the incident no longer reads as no check reported");
  assert(
    text.includes("The reschedule smoke also crashed: the connection timed out."),
    "it names the crash and its reason",
  );
  assert(text.includes("teardown: booking 98c0e697 left active"), "and the booking the crash left behind");
  eq(recorded.kind === "failures" ? recorded.passed : -1, 5, "with the slot check and 4 booking checks counted as passed");
}

// --- every smoke script with a main routes its crash through the recorder ---
const ROOT = join(import.meta.dirname, "..");
for (const f of [
  "smoke-booking-api.ts",
  "smoke-reschedule.ts",
  "smoke-523-stickiness.ts",
  "smoke-create-resume.ts",
  "smoke-embed-render.ts",
]) {
  const src = readFileSync(join(ROOT, "scripts", f), "utf8");
  assert(/\brecordSmokeCrash\(/.test(src), `${f} records its crash through recordSmokeCrash`);
  assert(!/^void main\(\);?$/m.test(src), `${f} does not drop a rejected main`);
}

// --- every script that writes the failure log records its passes too ---
// A writer of failures that never records a pass makes its passing checks invisible,
// and a crash after them reads as a crash before any check passed. Found from what
// writes the log (recordFailure), not a hand list (L96), so a new writer is covered.
const RECORDS_PASS = /\brecordPass\(/;
assert(!RECORDS_PASS.test("recordFailure(io, failureLog, line);"), "control: a failure only writer is caught");
const writers = ["smoke-booking-api.ts", "smoke-latency.ts", "smoke-embed-render.ts", "smoke-lib.ts"];
for (const f of writers) {
  const src = readFileSync(join(ROOT, "scripts", f), "utf8");
  assert(/\brecordFailure\(/.test(src), `${f} writes the failure log (so the list is not stale)`);
  assert(RECORDS_PASS.test(src), `${f} records a pass when its check passes`);
}
{
  // And no other smoke script writes the log directly, so the list above is complete.
  const { readdirSync } = await import("node:fs");
  const others = readdirSync(join(ROOT, "scripts"))
    .filter((f) => /^smoke-.*\.ts$/.test(f) && !writers.includes(f))
    .filter((f) => /\brecordFailure\(/.test(readFileSync(join(ROOT, "scripts", f), "utf8")));
  eq(others, [], "no other smoke script writes failures without being checked for passes");
}
// createChecker's pass, driven rather than read: one passing check is one [pass] mark.
{
  const log = fakeIo();
  const { check } = createChecker({ io: log, env: { SMOKE_FAILURE_FILE: P } });
  check(true, "a passing check");
  eq(log.files[P], "[pass]\n", "createChecker records a passing check as one pass mark");
}

finish();

// Tests for the parallel test orchestrator (scripts/run-tests.ts, #604).
// The orchestrator replaces a fail-fast bash loop; its whole reason to exist is
// that it must NOT stop at the first red file and must NOT hide later failures.
// So the load-bearing cases here are the failure paths: a mixed run and an
// all-red run both have to surface EVERY failing file in one pass.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-run-tests.ts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const runner = resolve(here, "run-tests.ts");
const fx = (name: string) => resolve(here, "__fixtures__/runner", name);

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

function runOrchestrator(files: string[]) {
  return spawnSync(
    "node",
    [
      "--experimental-strip-types",
      "--import",
      "./scripts/register-paths.mjs",
      runner,
      ...files,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

// --- All green: exit 0, and quiet (no per-file "ok:" spam leaks through) ---
{
  const r = runOrchestrator([fx("pass-a.ts"), fx("pass-b.ts")]);
  const out = (r.stdout || "") + (r.stderr || "");
  assert(r.status === 0, "all-passing run exits 0");
  assert(
    !out.includes("ok: pass-a first"),
    "passing files' stdout is suppressed (quiet on green)",
  );
  assert(/2 passed/.test(out), "summary reports 2 passed");
}

// --- Mixed: one pass, one fail. Must exit non-zero AND show the red file. ---
{
  const r = runOrchestrator([fx("pass-a.ts"), fx("fail-a.ts")]);
  const out = (r.stdout || "") + (r.stderr || "");
  assert(r.status !== 0, "a run with any failure exits non-zero");
  assert(
    out.includes("FAIL: fail-a marker ALPHA"),
    "failing file's captured output is shown",
  );
  assert(/1 failed/.test(out), "summary reports 1 failed");
}

// --- Two red files: the core #604 regression. BOTH must be reported; the
//     first failure must not hide the second (that was the fail-fast bug). ---
{
  const r = runOrchestrator([fx("fail-a.ts"), fx("fail-b.ts")]);
  const out = (r.stdout || "") + (r.stderr || "");
  assert(r.status !== 0, "all-failing run exits non-zero");
  assert(
    out.includes("FAIL: fail-a marker ALPHA"),
    "first failing file is reported",
  );
  assert(
    out.includes("FAIL: fail-b marker BRAVO") ||
      out.includes("BRAVO-THROW"),
    "second failing file is ALSO reported (no fail-fast, later failure not hidden)",
  );
  assert(/2 failed/.test(out), "summary reports 2 failed");
}

// --- A file that crashes (uncaught throw, no clean process.exit) still counts
//     as a failure, not a silent pass. ---
{
  const r = runOrchestrator([fx("fail-b.ts")]);
  assert(r.status !== 0, "an uncaught-throw file is counted as failed");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

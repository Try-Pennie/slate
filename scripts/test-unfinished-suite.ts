// #3520: a suite that stops before it calls finish() is a FAILURE, never a pass.
//
// The runner (`scripts/run-tests.ts`) judges each suite by its exit code alone. A suite
// whose main() awaits a promise that never settles does not crash: node finds the event
// loop empty and exits 0, so every assertion after the stop went unrun and the suite was
// counted green. That happened on 2026-10-08 in test-confirm-queue.ts, and again the same
// day in test-confirm-line-object.ts, where a deliberately broken line went unnoticed
// because the suite stopped at the await the break left unsettled (L1, L98).
//
// Each fixture is run exactly as the runner runs a suite (same node flags), and judged
// by what the runner reads: the exit code.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-unfinished-suite.ts
import { spawnSync } from "node:child_process";
import { assert, finish } from "./lib/harness.ts";

const NODE_ARGS = ["--experimental-strip-types", "--import", "./scripts/register-paths.mjs"];

function run(fixture: string, env: Record<string, string> = {}): { code: number | null; stderr: string; stdout: string } {
  const r = spawnSync(process.execPath, [...NODE_ARGS, `scripts/fixtures/unfinished-suite/${fixture}`], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, VITEST: "", ...env },
  });
  return { code: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

for (const [fixture, helper] of [
  ["stops-harness.ts", "the shared harness"],
  ["stops-asserter.ts", "the booking suites' asserter"],
] as const) {
  const r = run(fixture);
  assert(r.code === 1, `a suite on ${helper} that stops before finish() exits 1 (got ${r.code})`);
  assert(
    r.stderr.includes("FAIL: the suite stopped before it called finish()"),
    `and says why, on stderr, as a FAIL line (got ${JSON.stringify(r.stderr.slice(0, 300))})`,
  );
  assert(r.stdout.includes("ok: the one assertion before the stop"), `the assertion before the stop still ran (stdout ${JSON.stringify(r.stdout.slice(0, 200))})`);
}

// A reset starts the harness over, the guard included: a finish() made with an injected
// exit and then reset must not leave the process disarmed (the harness's own test does
// exactly that sequence).
const reset = run("stops-after-reset.ts");
assert(reset.code === 1 && reset.stderr.includes("stopped before it called finish()"), `resetHarness() arms the guard again (got ${reset.code})`);

// Control (L1): a suite that reaches finish() is untouched, so the two above fail for
// the stop and not for the flags or the fixture's imports.
const done = run("finishes.ts");
assert(done.code === 0, `a suite that reaches finish() still exits 0 (got ${done.code}; stderr ${JSON.stringify(done.stderr.slice(0, 300))})`);
assert(!done.stderr.includes("stopped before"), "and the guard says nothing about it");

// A vitest worker imports the harness only through the shared fakes
// (`src/lib/booking/manage-phone-lookup.test.ts`) and is judged by vitest's own report,
// so the guard stays out of it: how vitest ends a worker is vitest's business, and a
// guard that fired there would fail a file for a reason no test of it states.
const underVitest = run("stops-asserter.ts", { VITEST: "true" });
assert(underVitest.code === 0 && !underVitest.stderr.includes("stopped before"), `the guard is off in a vitest worker (got ${underVitest.code})`);

finish();

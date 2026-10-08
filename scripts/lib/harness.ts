// The single shared harness for the node-native test suite (#820 / AUD-022).
//
// Every scripts/test-*.ts used to re-declare its own `assert(cond, msg)` (or an
// `ok`/`check`/`fail` variant), its own `let failures = 0` counter, and its own
// trailing summary + `process.exit` block. That boilerplate drifted per file and
// had to be fixed in dozens of places. This module owns all of it:
//
//   import { assert, finish } from "./lib/harness.ts";
//   assert(x === y, "x equals y");
//   finish();
//
// The counter is module-level, which is safe because the runner
// (scripts/run-tests.ts) executes each test file in its own process.

let failures = 0;
/** Whether `finish()` was called: what the guard below reads (#3520). */
let finished = false;

/**
 * #3520: a suite that STOPS before it calls `finish()` fails. A main() awaiting a promise
 * that never settles does not crash: node finds the event loop empty and exits 0, and the
 * runner, which reads only the exit code, counted the suite green with every assertion
 * after the stop unrun. `beforeExit` fires exactly then, when the loop empties without an
 * explicit exit, so it is the one place that can tell. A suite that calls `finish()`
 * exits through it and never reaches this.
 */
process.on("beforeExit", () => {
  // A vitest worker reaches this module only through the shared fakes and is judged by
  // vitest's own report, never by this exit code.
  // env-ok: VITEST (set by vitest in its own workers and by nothing else; absent, which every workflow step leaves it, is what keeps the guard on)
  if (finished || process.env.VITEST) return;
  console.error(
    "FAIL: the suite stopped before it called finish(): an await that never settled ended it, " +
      "so every assertion after that point went unrun",
  );
  process.exit(1);
});

/** Pass/fail check: logs `ok:`/`FAIL:` and counts failures. */
export function assert(cond: boolean, msg: string): void {
  if (cond) console.log("ok:", msg);
  else {
    console.error("FAIL:", msg);
    failures++;
  }
}

/** Unconditional failure (for a branch that should never be reached). */
export function fail(msg: string): void {
  console.error("FAIL:", msg);
  failures++;
}

/** Equality sugar: asserts `actual` equals `expected` (deep-equal for objects). */
export function eq<T>(actual: T, expected: T, msg: string): void {
  const a = typeof actual === "object" && actual !== null ? JSON.stringify(actual) : String(actual);
  const e = typeof expected === "object" && expected !== null ? JSON.stringify(expected) : String(expected);
  assert(Object.is(actual, expected) || a === e, `${msg} (expected ${e}, got ${a})`);
}

/**
 * Print the canonical summary and exit: 0 when everything passed, 1 otherwise.
 * `exit` is injectable so the harness's own test can assert the code without
 * terminating the test process.
 */
export function finish(exit: (code: number) => unknown = process.exit): void {
  finished = true;
  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
  exit(failures === 0 ? 0 : 1);
}

/** Current failure count (test-only introspection). */
export function failureCount(): number {
  return failures;
}

/** Reset the counter and the guard (test-only, for isolating harness unit tests). */
export function resetHarness(): void {
  failures = 0;
  // A reset starts over, the #3520 guard included: a finish() made with an injected exit
  // before it must not disarm the guard for the rest of the process.
  finished = false;
}

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
  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
  exit(failures === 0 ? 0 : 1);
}

/** Current failure count (test-only introspection). */
export function failureCount(): number {
  return failures;
}

/** Reset the counter (test-only, for isolating harness unit tests). */
export function resetHarness(): void {
  failures = 0;
}

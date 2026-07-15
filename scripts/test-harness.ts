// Unit test for the shared node-test harness (#820 / AUD-022). Uses node:assert
// so it does not depend on the thing it is testing. The rest of the node-native
// suite re-declared its own assert(cond, msg) + failure counter + exit block in
// ~120 files; harness.ts is the single definition they now share.
// Run: node --experimental-strip-types scripts/test-harness.ts
import nodeAssert from "node:assert/strict";
import { assert, fail, eq, finish, failureCount, resetHarness } from "./lib/harness.ts";

resetHarness();
nodeAssert.equal(failureCount(), 0, "starts at 0");

assert(true, "passing assert does not count");
nodeAssert.equal(failureCount(), 0, "a passing assert keeps the count at 0");

assert(false, "failing assert counts");
nodeAssert.equal(failureCount(), 1, "a failing assert increments the count");

fail("explicit fail");
nodeAssert.equal(failureCount(), 2, "fail() increments the count unconditionally");

resetHarness();
eq(2 + 2, 4, "eq passes when values are equal");
nodeAssert.equal(failureCount(), 0, "a passing eq keeps the count at 0");

eq(1, 2, "eq fails when values differ");
nodeAssert.equal(failureCount(), 1, "a failing eq increments the count");

eq({ a: 1, b: [2] }, { a: 1, b: [2] }, "eq deep-compares objects");
nodeAssert.equal(failureCount(), 1, "a deep-equal object comparison passes");

// finish() reports the correct exit code via an injected exit, without killing
// this process, so both the clean and failing outcomes can be asserted.
resetHarness();
let code = -1;
finish((c) => {
  code = c;
});
nodeAssert.equal(code, 0, "finish exits 0 when nothing failed");

assert(false, "seed one failure");
finish((c) => {
  code = c;
});
nodeAssert.equal(code, 1, "finish exits 1 when something failed");

console.log("\nALL PASSED");
process.exit(0);

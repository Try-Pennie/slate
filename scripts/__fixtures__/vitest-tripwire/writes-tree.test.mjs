// Fixture for the vitest arm of the tree write tripwire (#2759): a test that
// PASSES while writing a file, from inside a vitest worker, which is a process the
// main vitest process started. Where it writes is handed in by the suite, so one
// fixture serves as the positive control (a path inside the watched tree) and the
// negative one (a path outside it). `test` and `expect` are vitest globals; see
// the config beside this file for why nothing imports vitest.
import { appendFileSync } from "node:fs";

test("writes where it is told, and passes", () => {
  const target = process.env.TRIPWIRE_FIXTURE_TARGET;
  expect(target, "the suite must hand this fixture a TRIPWIRE_FIXTURE_TARGET").toBeTruthy();
  // tree-write-ok: the target is a path under the suite's own mkdtempSync(tmpdir()) base
  appendFileSync(target, "// touched\n");
});

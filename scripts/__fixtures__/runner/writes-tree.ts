// Fixture for the tree write tripwire (#2733): a suite that passes while a CHILD
// PROCESS it starts writes a file. That is the shape the static scan in
// test-no-tree-writes.ts cannot see, because the write is nowhere in this file's
// source as an fs call. Where it writes is handed in by the test, so the same
// fixture serves as the positive control (a path inside the watched tree) and the
// negative one (a path outside it).
import { spawnSync } from "node:child_process";

const target = process.env.TRIPWIRE_FIXTURE_TARGET;
if (!target) {
  console.error("FAIL: writes-tree fixture was given no TRIPWIRE_FIXTURE_TARGET");
  process.exit(1);
}
const r = spawnSync(
  "node",
  ["-e", "require('node:fs').appendFileSync(process.argv[1], '// touched\\n')", target],
  { encoding: "utf8" },
);
if (r.status !== 0) {
  console.error("FAIL: the child could not write", target, r.stderr);
  process.exit(1);
}
console.log("ok: writes-tree wrote through a child process");
process.exit(0);

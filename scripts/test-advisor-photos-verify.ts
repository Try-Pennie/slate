// `pnpm verify:advisor-photos` exits on a code per outcome (#3027). Every declared
// code is PRODUCED here, and no two outcomes share one (L11, L151).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-advisor-photos-verify.ts
import { VERIFY_EXIT, verifyExitCode, verifyReport } from "./lib/advisor-photos-verify.ts";
import type { RefreshOutcome } from "../src/lib/advisor-photos/refresh.ts";
import type { RefreshPlan } from "../src/lib/advisor-photos/core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const plan = (over: Partial<RefreshPlan>): RefreshPlan => ({
  full: [],
  touch: [],
  failed: [],
  failedNeverRead: [],
  deleteIds: [],
  flipGuardTripped: false,
  heldNone: [],
  repeated: [],
  notInDirectory: [],
  streaks: [],
  counts: { attempted: 2, photo: 1, none: 1, placeholder: 0, notInDirectory: 0, failed: 0, gained: 0, lost: 0, changed: 0, unchanged: 2, deleted: 0 },
  ...over,
});
const measured = (over: Partial<RefreshPlan>, deadline = false): RefreshOutcome => ({ status: "measured", plan: plan(over), applied: false, verdict: !deadline, deadlineReached: deadline, notReached: deadline ? 4 : 0 });
const refused = (why: Extract<RefreshOutcome, { status: "refused" }>["why"]): RefreshOutcome => ({ status: "refused", why, detail: "x" });

const cases: [string, RefreshOutcome, number][] = [
  ["a clean run", measured({}), VERIFY_EXIT.ok],
  ["no subject", refused("no-subject"), VERIFY_EXIT.noSubject],
  ["Slate unreadable", refused("slate-unreadable"), VERIFY_EXIT.slateUnreadable],
  ["subject refused", refused("subject-refused"), VERIFY_EXIT.subjectRefused],
  ["directory unreadable", refused("directory-unreadable"), VERIFY_EXIT.directoryUnreadable],
  ["nothing read", refused("nothing-read"), VERIFY_EXIT.nothingRead],
  ["flip guard", measured({ flipGuardTripped: true, heldNone: ["a@x"] }), VERIFY_EXIT.flipGuard],
  ["repeated image", measured({ repeated: [{ sha256: "a".repeat(64), holders: ["a", "b", "c"], held: ["c"] }] }), VERIFY_EXIT.repeatedImage],
  ["not in directory", measured({ notInDirectory: ["a@x"] }), VERIFY_EXIT.notInDirectory],
  ["stopped at the deadline", measured({}, true), VERIFY_EXIT.deadline],
  ["failures", measured({ counts: { ...plan({}).counts, failed: 1 }, failedNeverRead: [{ email: "a@x", reason: "answered 503" }] }), VERIFY_EXIT.failures],
];
const produced = new Set<number>();
for (const [label, outcome, code] of cases) {
  eq(verifyExitCode(outcome), code, `${label} exits ${code}`);
  produced.add(verifyExitCode(outcome));
  assert(verifyReport(outcome).length > 0, `${label} prints something`);
}
const declared = new Set(Object.values(VERIFY_EXIT));
eq(declared.size, Object.keys(VERIFY_EXIT).length, "no two outcomes share an exit code");
for (const code of declared) assert(produced.has(code), `exit ${code} is produced by a case`);
assert(verifyReport(measured({ failedNeverRead: [{ email: "z@x", reason: "r" }] })).some((l) => l.includes("z@x")), "a failed person is named");

finish();

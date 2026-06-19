// Reap selection (#265): which Salesforce-inactive users to DEACTIVATE.
// Pure helper so the carve-outs are testable without a DB. With deactivate-not-
// delete, the old "never reap a user who manages OOO history" exception is gone:
// deactivation preserves the row, so attribution survives — every SF-inactive
// reapable user is selected purely by inactivity.
// Run: node --experimental-strip-types scripts/test-salesforce-reap.ts
import { reapableUserIds } from "../src/lib/salesforce/reap.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}
const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

const rows = [
  { id: "a", email: "Alice@Pennie.com" },
  { id: "b", email: "bob@pennie.com" },
  { id: "c", email: "carol@pennie.com" },
];

assert(
  eq(reapableUserIds(rows, new Set(["alice@pennie.com"])), ["a"]),
  "selects an inactive user, matching email case-insensitively",
);
assert(
  eq(reapableUserIds(rows, new Set(["bob@pennie.com", "carol@pennie.com"])), ["b", "c"]),
  "selects every inactive user",
);
assert(
  eq(reapableUserIds(rows, new Set<string>()), []),
  "nobody inactive selects nobody",
);
assert(
  eq(reapableUserIds([], new Set(["x@pennie.com"])), []),
  "empty roster selects nobody",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

// Active-user predicate (#265 offboarding): a user is active iff not deactivated.
// Pure helper used to hide deactivated people from rendered lists WITHOUT
// dropping them from the data (their names must still resolve on history).
// Run: node --experimental-strip-types scripts/test-active-user.ts
import { isActive, activeUsers } from "../src/lib/active-user.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

assert(isActive({ deactivated_at: null }) === true, "null deactivated_at = active");
assert(isActive({ deactivated_at: "2026-06-19T00:00:00Z" }) === false, "set deactivated_at = inactive");

const list = [
  { id: "a", deactivated_at: null },
  { id: "b", deactivated_at: "2026-06-19T00:00:00Z" },
  { id: "c", deactivated_at: null },
];
const active = activeUsers(list);
assert(
  JSON.stringify(active.map((u) => u.id)) === JSON.stringify(["a", "c"]),
  "activeUsers drops deactivated, preserves order of the rest",
);
assert(activeUsers([]).length === 0, "empty list yields empty");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

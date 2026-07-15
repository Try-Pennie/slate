// Reap selection (#265): which Salesforce-inactive users to DEACTIVATE.
// Pure helper so the carve-outs are testable without a DB. With deactivate-not-
// delete, the old "never reap a user who manages OOO history" exception is gone:
// deactivation preserves the row, so attribution survives — every SF-inactive
// reapable user is selected purely by inactivity.
// Run: node --experimental-strip-types scripts/test-salesforce-reap.ts
import { reapableUserIds } from "../src/lib/salesforce/reap.ts";
import { eq, finish } from "./lib/harness.ts";

const rows = [
  { id: "a", email: "Alice@Pennie.com" },
  { id: "b", email: "bob@pennie.com" },
  { id: "c", email: "carol@pennie.com" },
];

eq(
  reapableUserIds(rows, new Set(["alice@pennie.com"])),
  ["a"],
  "selects an inactive user, matching email case-insensitively",
);
eq(
  reapableUserIds(rows, new Set(["bob@pennie.com", "carol@pennie.com"])),
  ["b", "c"],
  "selects every inactive user",
);
eq(
  reapableUserIds(rows, new Set<string>()),
  [],
  "nobody inactive selects nobody",
);
eq(
  reapableUserIds([], new Set(["x@pennie.com"])),
  [],
  "empty roster selects nobody",
);

finish();

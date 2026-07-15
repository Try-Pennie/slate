// Tests for the daily pending-OOO digest core (send-time gate + message build).
// Run: node --experimental-strip-types scripts/test-ooo-digest.ts
import {
  buildManagerDigests,
  isDigestTime,
  type DigestManager,
} from "../src/lib/ooo/digest.ts";
import { assert, finish } from "./lib/harness.ts";

// --- send-time gate (9am ET weekdays) across DST ---
// EDT (summer): 9am ET = 13:00 UTC. 2026-07-01 is a Wednesday.
assert(isDigestTime(Date.parse("2026-07-01T13:00:00Z")), "13:00 UTC summer = 9am EDT");
assert(!isDigestTime(Date.parse("2026-07-01T14:00:00Z")), "14:00 UTC summer = 10am EDT (skip)");
// EST (winter): 9am ET = 14:00 UTC. 2026-01-07 is a Wednesday.
assert(!isDigestTime(Date.parse("2026-01-07T13:00:00Z")), "13:00 UTC winter = 8am EST (skip)");
assert(isDigestTime(Date.parse("2026-01-07T14:00:00Z")), "14:00 UTC winter = 9am EST");
// weekends never fire (2026-07-04 is a Saturday, 9am EDT = 13:00 UTC).
assert(!isDigestTime(Date.parse("2026-07-04T13:00:00Z")), "Saturday is skipped");
// off-hours never fire.
assert(!isDigestTime(Date.parse("2026-07-01T18:00:00Z")), "2pm ET is skipped");

// --- message building ---
const managers = new Map<string, DigestManager>([
  ["m1", { id: "m1", email: "mona@x.com", name: "Mona" }],
  ["m2", { id: "m2", email: "noname@x.com", name: null }],
]);
const pending = [
  { manager_id: "m1" },
  { manager_id: "m1" },
  { manager_id: "m1" },
  { manager_id: "m2" },
  { manager_id: null }, // unassigned: ignored
  { manager_id: "ghost" }, // manager not resolvable: ignored
];
const digests = buildManagerDigests(pending, managers, "https://slate.test/admin/ooo");

assert(digests.length === 2, "one digest per resolvable manager with pending");
assert(digests[0].managerId === "m1" && digests[0].count === 3, "busiest manager first");
assert(
  digests[0].text.includes("Good morning, Mona.") &&
    digests[0].text.includes("*3* time off requests") &&
    digests[0].text.includes("https://slate.test/admin/ooo"),
  "message has greeting, count, plural noun, and review link",
);
assert(
  digests[1].text.startsWith("Good morning. You have *1* time off request "),
  "no-name fallback greeting and singular noun",
);
assert(
  !digests.some((d) => d.text.includes("—") || d.text.includes("–")),
  "no em or en dashes in the copy",
);

// --- empty pending -> no digests ---
assert(buildManagerDigests([], managers, "x").length === 0, "no pending, no digests");

finish();

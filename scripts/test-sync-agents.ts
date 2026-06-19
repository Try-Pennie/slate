// The sync/watch loop must never process deactivated users (#274): a
// deactivated-but-still-bookable account kept getting synced + watched and
// could fire watch-renewal failure alerts forever for an account nobody can
// fix. toSyncAgents is the pure shaper behind loadSyncAgents; it drops
// deactivated rows (defense-in-depth behind the SQL filter) and maps the rest
// to the pacing facts both lanes rotate on.
// Run: node --experimental-strip-types scripts/test-sync-agents.ts
import { toSyncAgents } from "../src/lib/google/sync-pace.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const rows = [
  { id: "active", last_synced_at: null, deactivated_at: null },
  { id: "deactivated", last_synced_at: null, deactivated_at: "2026-06-19T00:00:00Z" },
  { id: "synced", last_synced_at: "2026-06-01T00:00:00Z", deactivated_at: null },
];

const agents = toSyncAgents(rows, new Set(["active"]));
const ids = agents.map((a) => a.userId).sort();

assert(
  JSON.stringify(ids) === JSON.stringify(["active", "synced"]),
  "drops the deactivated user, keeps the active ones (order preserved among kept)",
);
assert(
  !ids.includes("deactivated"),
  "a deactivated-but-bookable user is excluded from the sync/watch loop",
);
assert(
  agents.find((a) => a.userId === "active")?.hasCalendars === true,
  "calendar presence is resolved from the provided set",
);
assert(
  agents.find((a) => a.userId === "synced")?.hasCalendars === false,
  "an agent absent from the calendar set has hasCalendars=false",
);
assert(
  agents.find((a) => a.userId === "synced")?.lastSyncedMs === Date.parse("2026-06-01T00:00:00Z"),
  "last_synced_at is parsed to epoch ms; null stays null",
);
assert(
  agents.find((a) => a.userId === "active")?.lastSyncedMs === null,
  "never-synced agent keeps lastSyncedMs null",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

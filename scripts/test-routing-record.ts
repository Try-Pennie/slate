// Pure assembly test for buildRoutingTraceExtras.
// Imports from explain.ts (relative/type-only @/ imports only) so
// node --experimental-strip-types can load it without @/ resolution.
// recordRoutingDecision lives in record.ts with @/ value imports and is
// NOT node-testable; verified by tsc + vitest + live check.
// Run: node --experimental-strip-types scripts/test-routing-record.ts
import { buildRoutingTraceExtras } from "../src/lib/routing/explain.ts";
import type { Attributes } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

const pool = {
  orgAgents: [
    { id: "a", attributes: { debt_team: "ultra_high" } as Attributes },
    { id: "b", attributes: { debt_team: "very_high" } as Attributes },
  ],
  manualMemberIds: new Set<string>(),
  criteria: { debt_team: "ultra_high" },
};
const extras = buildRoutingTraceExtras(pool, ["a"]);
assert(extras.considered.join(",") === "a", "considered carried from free ids");
assert(
  extras.excluded.some((e) => e.user_id === "b" && e.reason === "criteria_miss"),
  "non-matching agent recorded as criteria_miss",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

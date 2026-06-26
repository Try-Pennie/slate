// Routing pool: pure agentIdsFromPool helper extracted for the decision log (Task 7).
// Note: this test imports from pool.ts rather than service.ts — service.ts has @/ value
// imports that node --experimental-strip-types cannot resolve; per the task brief escape
// hatch, agentIdsFromPool is extracted to the pure pool.ts (no @/ value imports) and
// re-exported from service.ts for non-node consumers. See task-6-report.md for details.
// Run: node --experimental-strip-types scripts/test-routing-pool.ts
import { agentIdsFromPool } from "../src/lib/availability/pool.ts";
import type { Attributes } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

// agentIdsFromPool is the pure filter extracted from resolveBucketAgentIds.
const orgAgents: { id: string; attributes: Attributes }[] = [
  { id: "a", attributes: { debt_team: "ultra_high" } },
  { id: "b", attributes: { debt_team: "low" } },
  { id: "c", attributes: { debt_team: "low" } }, // manual member
];
const ids = agentIdsFromPool(orgAgents, new Set(["c"]), { debt_team: "ultra_high" });
assert(ids.sort().join(",") === "a,c", "matched criteria OR manual member");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

// Sanity test for the routing-attribute catalog derivation.
// Run: node --experimental-strip-types scripts/test-catalog.ts
import { deriveAttributeCatalog } from "../src/lib/availability/catalog.ts";
import type { Attributes } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const agents: (Attributes | null)[] = [
  { debt_team: ["ultra_high", "high"], role: "sales_agent", legal_eligible: true },
  { debt_team: "high", role: "manager", backend_service: "achieve" },
  { debt_team: ["low"], role: "sales_agent", legal_eligible: false },
  null,
  { debt_team: "" }, // empty value ignored
];

const cat = deriveAttributeCatalog(agents);

assert(JSON.stringify(cat.debt_team) === JSON.stringify(["high", "low", "ultra_high"]), "unions + sorts array and scalar values across agents");
assert(JSON.stringify(cat.role) === JSON.stringify(["manager", "sales_agent"]), "dedups scalar values");
assert(JSON.stringify(cat.legal_eligible) === JSON.stringify(["false", "true"]), "booleans become string options");
assert(JSON.stringify(cat.backend_service) === JSON.stringify(["achieve"]), "keys present on only some agents are included");
assert(JSON.stringify(Object.keys(cat)) === JSON.stringify(["backend_service", "debt_team", "legal_eligible", "role"]), "keys are sorted");
assert(!cat.debt_team.includes(""), "empty values are dropped");
assert(JSON.stringify(deriveAttributeCatalog([])) === "{}", "no agents yields an empty catalog");
assert(JSON.stringify(deriveAttributeCatalog([null, undefined])) === "{}", "null/undefined attributes are skipped");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

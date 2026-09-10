// Sanity test for the routing-attribute catalog derivation.
// Run: node --experimental-strip-types scripts/test-catalog.ts
import { deriveAttributeCatalog } from "../src/lib/availability/catalog.ts";
import type { Attributes } from "../src/lib/db/types.ts";
import { assert, finish } from "./lib/harness.ts";

const agents: (Attributes | null)[] = [
  { debt_team: ["ultra_high", "high"], role: "sales_agent", trades_access: true },
  { debt_team: "high", role: "manager", backend_service: "achieve" },
  { debt_team: ["low"], role: "sales_agent", trades_access: false },
  null,
  { debt_team: "" }, // empty value ignored
];

const cat = deriveAttributeCatalog(agents);

assert(JSON.stringify(cat.debt_team) === JSON.stringify(["high", "low", "ultra_high"]), "unions + sorts array and scalar values across agents");
assert(JSON.stringify(cat.role) === JSON.stringify(["manager", "sales_agent"]), "dedups scalar values");
assert(JSON.stringify(cat.trades_access) === JSON.stringify(["false", "true"]), "booleans become string options");
assert(JSON.stringify(cat.backend_service) === JSON.stringify(["achieve"]), "keys present on only some agents are included");
// The PROPERTY, not a hand written order. The literal here read
// ["backend_service", "debt_team", "trades_access", "role"], which is not sorted:
// it was written when the third key sorted before `role` and nothing ever
// re-checked it against the claim in its own message (L63).
{
  const keys = Object.keys(cat);
  assert(JSON.stringify(keys) === JSON.stringify([...keys].sort()), `keys are sorted (${keys.join(", ")})`);
  assert(
    JSON.stringify([...keys].sort()) ===
      JSON.stringify(["backend_service", "debt_team", "role", "trades_access"]),
    `and every key the agents carry is present (${keys.join(", ")})`,
  );
}
assert(!cat.debt_team.includes(""), "empty values are dropped");
assert(JSON.stringify(deriveAttributeCatalog([])) === "{}", "no agents yields an empty catalog");
assert(JSON.stringify(deriveAttributeCatalog([null, undefined])) === "{}", "null/undefined attributes are skipped");

finish();

// Sanity test for attribute-criteria matching.
// Run: node --experimental-strip-types scripts/test-match.ts
import { matchesCriteria } from "../src/lib/availability/match.ts";
import { assert, finish } from "./lib/harness.ts";

const agent = {
  debt_team: ["very_high", "ultra_high"],
  backend_service: "achieve",
  role: "sales_agent",
  backend_service: true,
};

assert(matchesCriteria(agent, { debt_team: "ultra_high" }), "array attr matches scalar criterion");
assert(matchesCriteria(agent, { role: "sales_agent", debt_team: "ultra_high" }), "all keys must match (both do)");
assert(!matchesCriteria(agent, { role: "manager" }), "non-matching role fails");
assert(!matchesCriteria(agent, { debt_team: "low" }), "debt team not in agent's teams fails");
assert(!matchesCriteria(agent, { role: "sales_agent", debt_team: "low" }), "one mismatched key fails the AND");
assert(matchesCriteria(agent, { backend_service: true }), "boolean criterion matches");
assert(!matchesCriteria(agent, { backend_service: false }), "boolean mismatch fails");
assert(matchesCriteria(agent, { debt_team: ["low", "ultra_high"] }), "array criterion intersects array attr");
assert(!matchesCriteria(agent, {}), "empty criteria matches nobody");
assert(!matchesCriteria(agent, { missing_key: "x" }), "absent attribute fails");
assert(!matchesCriteria(null, { role: "sales_agent" }), "null attributes never match");

// --- negated keys ("!" suffix): cal.com "does not equal" semantics (#66) ---
assert(
  matchesCriteria({ debt_team: ["low"] }, { debt_team: "low", "backend_service!": "beyond" }),
  "unset attribute PASSES a negated criterion (cal.com: unset != N)",
);
assert(
  !matchesCriteria(
    { debt_team: ["low"], backend_service: "beyond" },
    { debt_team: "low", "backend_service!": "beyond" },
  ),
  "explicitly marked N is excluded",
);
assert(
  matchesCriteria(
    { debt_team: ["low"], backend_service: "achieve" },
    { debt_team: "low", "backend_service!": "beyond" },
  ),
  "marked Y passes the negation",
);
assert(
  !matchesCriteria(
    { debt_team: ["low"], backend_service: ["achieve", "beyond"] },
    { debt_team: "low", "backend_service!": "beyond" },
  ),
  "array attribute containing a banned value is excluded",
);
assert(
  !matchesCriteria({ backend_service: "achieve" }, { "backend_service!": "beyond", debt_team: "low" }),
  "negation does not weaken the other keys (missing debt_team still fails)",
);
assert(
  matchesCriteria({}, { "backend_service!": "beyond" }),
  "negation-only criteria match unmarked agents (consistent with cal.com's !=; real buckets always also pin debt_team)",
);

finish();

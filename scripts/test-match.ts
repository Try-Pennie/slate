// Sanity test for attribute-criteria matching.
// Run: node --experimental-strip-types scripts/test-match.ts
import { matchesCriteria } from "../src/lib/availability/match.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const agent = {
  debt_team: ["very_high", "ultra_high"],
  backend_service: "achieve",
  role: "sales_agent",
  legal_eligible: true,
};

assert(matchesCriteria(agent, { debt_team: "ultra_high" }), "array attr matches scalar criterion");
assert(matchesCriteria(agent, { role: "sales_agent", debt_team: "ultra_high" }), "all keys must match (both do)");
assert(!matchesCriteria(agent, { role: "manager" }), "non-matching role fails");
assert(!matchesCriteria(agent, { debt_team: "low" }), "debt team not in agent's teams fails");
assert(!matchesCriteria(agent, { role: "sales_agent", debt_team: "low" }), "one mismatched key fails the AND");
assert(matchesCriteria(agent, { legal_eligible: true }), "boolean criterion matches");
assert(!matchesCriteria(agent, { legal_eligible: false }), "boolean mismatch fails");
assert(matchesCriteria(agent, { debt_team: ["low", "ultra_high"] }), "array criterion intersects array attr");
assert(!matchesCriteria(agent, {}), "empty criteria matches nobody");
assert(!matchesCriteria(agent, { missing_key: "x" }), "absent attribute fails");
assert(!matchesCriteria(null, { role: "sales_agent" }), "null attributes never match");

// --- negated keys ("!" suffix): cal.com "does not equal" semantics (#66) ---
assert(
  matchesCriteria({ debt_team: ["low"] }, { debt_team: "low", "legal_eligible!": "N" }),
  "unset attribute PASSES a negated criterion (cal.com: unset != N)",
);
assert(
  !matchesCriteria(
    { debt_team: ["low"], legal_eligible: "N" },
    { debt_team: "low", "legal_eligible!": "N" },
  ),
  "explicitly marked N is excluded",
);
assert(
  matchesCriteria(
    { debt_team: ["low"], legal_eligible: "Y" },
    { debt_team: "low", "legal_eligible!": "N" },
  ),
  "marked Y passes the negation",
);
assert(
  !matchesCriteria(
    { debt_team: ["low"], legal_eligible: ["Y", "N"] },
    { debt_team: "low", "legal_eligible!": "N" },
  ),
  "array attribute containing a banned value is excluded",
);
assert(
  !matchesCriteria({ legal_eligible: "Y" }, { "legal_eligible!": "N", debt_team: "low" }),
  "negation does not weaken the other keys (missing debt_team still fails)",
);
assert(
  matchesCriteria({}, { "legal_eligible!": "N" }),
  "negation-only criteria match unmarked agents (consistent with cal.com's !=; real buckets always also pin debt_team)",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

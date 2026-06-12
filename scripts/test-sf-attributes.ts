// Sanity test for the SF attribute merge (#66): Salesforce owns its keys,
// Slate-managed keys survive the sync.
// Run: node --experimental-strip-types scripts/test-sf-attributes.ts
import { mergeSfAttributes, SF_MANAGED_KEYS } from "../src/lib/salesforce/attributes.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

assert(
  eq(
    mergeSfAttributes(
      { debt_team: ["low"], legal_eligible: "Y" },
      { debt_team: ["ultra_high"], role: "Sales" },
    ),
    { legal_eligible: "Y", debt_team: ["ultra_high"], role: "Sales" },
  ),
  "Slate-managed legal_eligible survives; SF keys replaced",
);

assert(
  eq(
    mergeSfAttributes(
      { debt_team: ["low"], backend_service: ["beyond"], legal_eligible: "N" },
      { debt_team: ["low"] },
    ),
    { legal_eligible: "N", debt_team: ["low"] },
  ),
  "an SF flag un-checked in Salesforce is REMOVED, not kept from the old value",
);

assert(
  eq(mergeSfAttributes(null, { role: "Sales" }), { role: "Sales" }),
  "null existing attributes behave like empty",
);

assert(
  eq(mergeSfAttributes({ legal_eligible: "Y" }, {}), { legal_eligible: "Y" }),
  "agent dropped from every SF flag still keeps Slate-managed keys",
);

assert(
  SF_MANAGED_KEYS.includes("debt_team") &&
    SF_MANAGED_KEYS.includes("backend_service") &&
    SF_MANAGED_KEYS.includes("role") &&
    !(SF_MANAGED_KEYS as readonly string[]).includes("legal_eligible"),
  "SF owns debt_team/backend_service/role; legal_eligible is Slate-managed",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

// Sanity test for the SF attribute merge (#66): Salesforce owns its keys,
// Slate-managed keys survive the sync.
// Run: node --experimental-strip-types scripts/test-sf-attributes.ts
import { mergeSfAttributes, SF_MANAGED_KEYS } from "../src/lib/salesforce/attributes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

eq(
  mergeSfAttributes(
    { debt_team: ["low"], legal_eligible: "Y" },
    { debt_team: ["ultra_high"], role: "Sales" },
  ),
  { legal_eligible: "Y", debt_team: ["ultra_high"], role: "Sales" },
  "Slate-managed legal_eligible survives; SF keys replaced",
);

eq(
  mergeSfAttributes(
    { debt_team: ["low"], backend_service: ["beyond"], legal_eligible: "N" },
    { debt_team: ["low"] },
  ),
  { legal_eligible: "N", debt_team: ["low"] },
  "an SF flag un-checked in Salesforce is REMOVED, not kept from the old value",
);

eq(
  mergeSfAttributes(null, { role: "Sales" }),
  { role: "Sales" },
  "null existing attributes behave like empty",
);

eq(
  mergeSfAttributes({ legal_eligible: "Y" }, {}),
  { legal_eligible: "Y" },
  "agent dropped from every SF flag still keeps Slate-managed keys",
);

// #2097: `users.attributes` now has TWO writers, the Salesforce sync and the Twilio
// half of the same run, and this merge is the Salesforce one. The redistribute mark is
// what tells the Twilio half who IT took out of the pool, so a merge that dropped it
// would silently end the reverse flip: the agent stays out of the pool for good, and
// nothing anywhere reports it. Pinned here rather than trusted to the spread, because
// this is the file somebody edits when they change what Salesforce owns.
eq(
  mergeSfAttributes(
    { debt_team: ["low"], redistribute: "Y" },
    { debt_team: ["high"], role: "Sales" },
  ),
  { redistribute: "Y", debt_team: ["high"], role: "Sales" },
  "the Twilio redistribute mark survives a Salesforce sync",
);

assert(
  !(SF_MANAGED_KEYS as readonly string[]).includes("redistribute"),
  "and Salesforce does not own it, so nothing here may clear it",
);

assert(
  SF_MANAGED_KEYS.includes("debt_team") &&
    SF_MANAGED_KEYS.includes("backend_service") &&
    SF_MANAGED_KEYS.includes("role") &&
    !(SF_MANAGED_KEYS as readonly string[]).includes("legal_eligible"),
  "SF owns debt_team/backend_service/role; legal_eligible is Slate-managed",
);

finish();

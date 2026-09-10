// Sanity test for the SF attribute merge (#66): Salesforce owns its keys,
// everything else survives the sync.
//
// WHAT SALESFORCE OWNS SHRANK TO ONE KEY IN #2152. `debt_team` and
// `backend_service` came from Salesforce booleans while cal.com took the same facts
// from Twilio TaskRouter tags, and nothing reconciled the two, so Twilio became the
// source and these keys left this list. That is not cosmetic: this merge DELETES an
// owned key before it merges, so leaving them here would have had the Salesforce
// half of the hourly run strip whatever the Twilio half wrote.
// Run: node --experimental-strip-types scripts/test-sf-attributes.ts
import { mergeSfAttributes, SF_MANAGED_KEYS } from "../src/lib/salesforce/attributes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

eq(
  mergeSfAttributes({ role: "Chatter Free User", legal_eligible: "Y" }, { role: "Sales" }),
  { legal_eligible: "Y", role: "Sales" },
  "the profile is replaced by what Salesforce holds now; every other key survives",
);

eq(
  mergeSfAttributes({ role: "Sales" }, {}),
  {},
  "a profile Salesforce no longer reports is REMOVED, not kept from the old value",
);

eq(
  mergeSfAttributes(null, { role: "Sales" }),
  { role: "Sales" },
  "null existing attributes behave like empty",
);

eq(
  mergeSfAttributes({ legal_eligible: "Y" }, {}),
  { legal_eligible: "Y" },
  "an agent Salesforce reports nothing about still keeps every key it does not own",
);

// #2152: the sharp one. The Twilio half of the same hourly run writes the tiers and
// the backend, and the Salesforce half runs FIRST inside the same lock. A merge that
// still owned these keys would delete an agent's tiers every hour and Twilio would
// write them back an instant later, so every reader in between would see an agent
// belonging to no bucket at all.
eq(
  mergeSfAttributes(
    { debt_team: ["high"], backend_service: ["beyond"], legal_eligible: "N", role: "Sales" },
    { role: "Sales" },
  ),
  { debt_team: ["high"], backend_service: ["beyond"], legal_eligible: "N", role: "Sales" },
  "the debt tiers and backend service Twilio wrote survive a Salesforce sync untouched",
);

// #2097: `users.attributes` has TWO writers, the Salesforce sync and the Twilio half
// of the same run, and this merge is the Salesforce one. The redistribute mark is
// what tells the Twilio half who IT took out of the pool, so a merge that dropped it
// would silently end the reverse flip: the agent stays out of the pool for good, and
// nothing anywhere reports it. Pinned here rather than trusted to the spread, because
// this is the file somebody edits when they change what Salesforce owns.
eq(
  mergeSfAttributes({ redistribute: "Y" }, { role: "Sales" }),
  { redistribute: "Y", role: "Sales" },
  "the Twilio redistribute mark survives a Salesforce sync",
);

// Stated as the whole list rather than as one membership test per key, so a key
// ADDED here has to be a deliberate act: this is the list that decides what an
// hourly Salesforce run is allowed to delete.
eq(
  [...SF_MANAGED_KEYS],
  ["role"],
  "Salesforce owns the profile and nothing else; the routing attributes and the redistribute mark are Twilio's",
);

assert(
  !(SF_MANAGED_KEYS as readonly string[]).includes("debt_team") &&
    !(SF_MANAGED_KEYS as readonly string[]).includes("backend_service"),
  "and it may never own the routing attributes again without somebody changing this line",
);

finish();

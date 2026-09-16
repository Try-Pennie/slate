// Reap selection (#265): which users to DEACTIVATE, and which the reap REFUSES.
//
// Pure helper so the carve-outs are testable without a DB. With deactivate-not-
// delete, the old "never reap a user who manages OOO history" exception is gone:
// deactivation preserves the row, so attribution survives.
//
// Since #2387 it no longer decides anything about a shared Salesforce address
// itself: it is handed each row's standing, read once by `readSalesforceStanding`,
// which the roster reconcile reads too. The reading and the agreement between the
// two are driven by scripts/test-salesforce-presence.ts; this file is the mapping
// from a standing to an action.
//
// Run: node --experimental-strip-types scripts/test-salesforce-reap.ts
import { planReap } from "../src/lib/salesforce/reap.ts";
import { eq, finish } from "./lib/harness.ts";

eq(
  planReap([{ id: "a", email: "Alice@Pennie.com", standing: "departed" }]).deactivate,
  ["a"],
  "selects a departed user",
);
eq(
  planReap([
    { id: "b", email: "bob@pennie.com", standing: "departed" },
    { id: "c", email: "carol@pennie.com", standing: "departed" },
  ]).deactivate,
  ["b", "c"],
  "selects every departed user",
);
eq(
  planReap([
    { id: "a", email: "alice@pennie.com", standing: "held" },
    { id: "b", email: "bob@pennie.com", standing: "absent" },
  ]).deactivate,
  [],
  "nobody departed selects nobody: an address Salesforce did not return is not a departure",
);
eq(planReap([]).deactivate, [], "empty roster selects nobody");

{
  // The #2387 case. A shared address with records that disagree is NOT a
  // departure, and it is not silence either: acting on nobody and acting on the
  // wrong person read alike from outside a run unless the refusal is carried out
  // (L98).
  const plan = planReap([
    { id: "d", email: "shared@pennie.com", standing: "ambiguous" },
    { id: "e", email: "gone@pennie.com", standing: "departed" },
  ]);
  eq(plan.deactivate, ["e"], "an unsettleable address is not deactivated");
  eq(
    plan.refused,
    [{ userId: "d", email: "shared@pennie.com" }],
    "and it is reported, with the row named so a person can go and look at it",
  );
}

finish();

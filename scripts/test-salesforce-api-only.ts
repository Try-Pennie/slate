// API only Salesforce accounts are never a person, so they never answer for one (#3669).
//
// The roster sync matches a Slate user to a Salesforce user by email. Salesforce
// needs a deliverable address on an integration account, so those accounts are
// routinely created carrying a real colleague's email. On 2026-10-13 one ("integration
// launchpad", profile "Salesforce API Only System Integrations") made one staff
// address answer to two active users and raised the ambiguous conflict page about a
// person with nothing wrong.
//
// The predicate is the PROFILE's `PermissionsApiUserOnly`, read against the live org
// on 2026-10-13: true on every integration profile (Salesforce Integration licence,
// Analytics Cloud, Sales Insights, CPQ) and false on every human one (Sales, Sales
// Manager, System Administrator, Standard User, Chatter Free, Identity). `UserType`
// cannot tell them apart: it read `Standard` on every active user.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-salesforce-api-only.ts

import { assert, eq, finish } from "./lib/harness.ts";
import {
  API_ONLY_PROFILE_FIELD,
  isApiOnlyAccount,
  partitionApiOnly,
  requireApiOnlyField,
} from "../src/lib/salesforce/api-only.ts";

// --- the predicate ------------------------------------------------------------
eq(
  isApiOnlyAccount({ Profile: { PermissionsApiUserOnly: true } }),
  true,
  "an API only profile is an integration account",
);
eq(
  isApiOnlyAccount({ Profile: { PermissionsApiUserOnly: false } }),
  false,
  "a profile that can log in is a person",
);
// Anything the response did not say is read as a PERSON, because that is the
// direction that stays visible: a person wrongly kept raises the conflict page,
// while a person wrongly dropped vanishes from the roster in silence.
eq(isApiOnlyAccount({ Profile: null }), false, "a missing profile is not proof of an integration");
eq(isApiOnlyAccount({}), false, "a record with no profile field is not proof of an integration");
eq(
  isApiOnlyAccount({ Profile: { PermissionsApiUserOnly: null } }),
  false,
  "a null flag is not proof of an integration",
);

// --- the partition keeps order and drops only the integration accounts --------
{
  const rows = [
    { Id: "005P1", Email: "staff@x.com", Profile: { PermissionsApiUserOnly: false } },
    { Id: "005I1", Email: "staff@x.com", Profile: { PermissionsApiUserOnly: true } },
    { Id: "005P2", Email: "other@x.com", Profile: null },
  ];
  const { people, apiOnly } = partitionApiOnly(rows);
  eq(
    people.map((r) => r.Id),
    ["005P1", "005P2"],
    "the people stay, in order",
  );
  eq(
    apiOnly.map((r) => r.Id),
    ["005I1"],
    "the integration account is set aside, not lost, so it can be counted",
  );
}

// --- every query must ASK for the field ---------------------------------------
//
// A query that does not select it returns records with no profile flag, which the
// predicate reads as people, so the exclusion would silently stop applying. Refused
// at the call rather than trusted.
{
  let threw = false;
  try {
    requireApiOnlyField("SELECT Id, Email FROM User WHERE IsActive = true");
  } catch (err) {
    threw = true;
    assert(
      String((err as Error).message).includes(API_ONLY_PROFILE_FIELD),
      "the refusal names the field the query is missing",
    );
  }
  assert(threw, "a User query that does not select the profile flag is refused");
}
{
  let threw = false;
  try {
    requireApiOnlyField(`SELECT Id, Email, ${API_ONLY_PROFILE_FIELD} FROM User WHERE IsActive = true`);
  } catch {
    threw = true;
  }
  assert(!threw, "a query that selects the profile flag is accepted");
}
// Naming it only in the WHERE clause is not selecting it: the records would come
// back without the flag and every one would read as a person.
{
  let threw = false;
  try {
    requireApiOnlyField(
      `SELECT Id, Email FROM User WHERE ${API_ONLY_PROFILE_FIELD} = false AND IsActive = true`,
    );
  } catch {
    threw = true;
  }
  assert(threw, "the field in the WHERE clause alone does not count as selected");
}

finish();

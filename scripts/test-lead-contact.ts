// #3541: the Salesforce Lead's name, email and phone, read for a Marcia move (or a
// book landing on the lead's held call) whose token and earlier bookings lack one
// (Dan, 2026-10-20; a net new book is refused before any lookup), through the
// injected SOQL runner.
//
//   - one query, by the id, asking a constant field list;
//   - Name, FirstName, Email kept; Phone first, MobilePhone when Phone is empty,
//     the order the call me now reader already uses;
//   - an empty or non text field is null, never "";
//   - a lead Salesforce did not return is null, matched on the 15 character key so
//     an 18 character answer to a 15 character question is still found;
//   - a refused query THROWS, so the caller can report it rather than read it as
//     a lead with no details.
//
// Every value is invented.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-lead-contact.ts
import {
  LEAD_CONTACT_SOQL_FIELDS,
  LEAD_PLACE_SOQL_FIELDS,
  readLeadContact,
  readLeadWithPlace,
} from "../src/lib/salesforce/lead-contact.ts";
import type { LeadFieldRecord } from "../src/lib/salesforce/lead-xbc.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ID15 = "00Q000000000000";
const ID18 = `${ID15}AAA`;

const runner = (records: LeadFieldRecord[]) => {
  const asked: string[] = [];
  return {
    asked,
    run: async (soql: string) => {
      asked.push(soql);
      return records;
    },
  };
};

{
  const r = runner([{ Id: ID18, Name: "Invented Lead", FirstName: "Invented", Email: "invented.lead@example.com", Phone: "(555) 555-0100", MobilePhone: "+15555550199" }]);
  const c = await readLeadContact(ID15, r.run);
  eq(c, { name: "Invented Lead", firstName: "Invented", email: "invented.lead@example.com", phone: "(555) 555-0100" }, "the Lead's name, first name, email and Phone");
  eq(r.asked.length, 1, "in one query");
  assert(r.asked[0]!.includes(`FROM Lead WHERE Id IN ('${ID15}')`) && r.asked[0]!.startsWith(`SELECT ${LEAD_CONTACT_SOQL_FIELDS} `), "by the id, asking the constant field list");
}

{
  const c = await readLeadContact(ID18, runner([{ Id: ID18, Name: "Invented Lead", FirstName: null, Email: "", Phone: "  ", MobilePhone: "+15555550199" }]).run);
  eq(c, { name: "Invented Lead", firstName: null, email: null, phone: "+15555550199" }, "an empty Phone falls to MobilePhone, and empty fields are null");
  const typed = await readLeadContact(ID18, runner([{ Id: ID18, Name: 42, FirstName: true, Email: { a: 1 }, Phone: 5555550100, MobilePhone: null }]).run);
  eq(typed, { name: null, firstName: null, email: null, phone: null }, "a field that is not text is null, never coerced");
}

{
  eq(await readLeadContact(ID18, runner([]).run), null, "a lead Salesforce did not return is null");
  eq(await readLeadContact(ID18, runner([{ Id: "00Q111111111111BBB", Name: "Someone Else" }]).run), null, "and so is an answer about another lead");
}

{
  let threw = false;
  try {
    await readLeadContact(ID18, async () => {
      throw new Error("SF query failed: 503");
    });
  } catch {
    threw = true;
  }
  assert(threw, "a refused query throws, so it is reported rather than read as a lead with no details");
}

// #4205: the coordinator page reads the same contact fields plus where the customer
// lives (PostalCode, State), the only source of their time zone, in ONE query.
{
  const r = runner([{ Id: ID18, Name: "Invented Lead", FirstName: "Invented", Email: "invented.lead@example.com", Phone: null, MobilePhone: "+15555550199", PostalCode: " 07030 ", State: "NJ" }]);
  const c = await readLeadWithPlace(ID15, r.run);
  eq(
    c,
    { id: ID18, name: "Invented Lead", firstName: "Invented", email: "invented.lead@example.com", phone: "+15555550199", postalCode: "07030", state: "NJ" },
    "the contact fields, the place fields, and the id as Salesforce spells it",
  );
  eq(r.asked.length, 1, "in one query");
  assert(r.asked[0]!.startsWith(`SELECT ${LEAD_PLACE_SOQL_FIELDS} `) && LEAD_PLACE_SOQL_FIELDS.startsWith(LEAD_CONTACT_SOQL_FIELDS), "asking the contact field list and the place fields");
  const blank = await readLeadWithPlace(ID18, runner([{ Id: ID18, Name: "Invented Lead", PostalCode: 7030, State: "" }]).run);
  eq([blank?.postalCode, blank?.state], [null, null], "a place field that is empty or not text is null, never coerced");
  eq(await readLeadWithPlace(ID18, runner([]).run), null, "a lead Salesforce did not return is null");
  let threw = false;
  try {
    await readLeadWithPlace(ID18, async () => {
      throw new Error("SF query failed: 503");
    });
  } catch {
    threw = true;
  }
  assert(threw, "and a refused query throws");
}

finish();

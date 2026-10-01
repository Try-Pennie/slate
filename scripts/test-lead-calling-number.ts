// The number Pennie will call a booked lead FROM (#1334). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-lead-calling-number.ts
//
// Read from Salesforce Lead `AssignedRegalPhone__c`, which a Pipedream workflow writes
// about a minute after the lead is created. What this file pins:
//  - the three answers stay apart: a number, a lead whose field is empty, and a
//    lead Salesforce did not return; a refused query THROWS rather than reading as
//    "no number" for everybody;
//  - anything that is not a valid phone number is treated as NO number, because a
//    wrong number is worse than none (L75);
//  - a value that is not a Salesforce Lead id is never asked about;
//  - the deadline the manage page reads under answers null when Salesforce is slow,
//    on an injected sleep rather than a real one (L524).
import {
  callingNumberOf,
  readLeadCallingNumbers,
  readOneCallingNumber,
  withDeadline,
} from "../src/lib/salesforce/lead-calling-number.ts";
import { readLeadXbcs } from "../src/lib/salesforce/lead-xbc.ts";
import { bookingLeadId } from "../src/lib/booking/lookup-identity.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const LEAD_A = "00QUi000010889ZMAQ";
const LEAD_B = "00QUi00000ABCDEFGH";

// --- what counts as a number ---------------------------------------------------
eq(callingNumberOf("+12197588170"), "+12197588170", "an E.164 number is kept as stored");
eq(callingNumberOf("(219) 758-8170"), "+12197588170", "a US number typed for reading is normalised to E.164");
eq(callingNumberOf(null), null, "an empty field is no number");
eq(callingNumberOf(""), null, "a blank string is no number");
eq(callingNumberOf("   "), null, "whitespace is no number");
eq(callingNumberOf("TBD"), null, "a placeholder is no number rather than a number we would print");
eq(callingNumberOf("+1219758"), null, "a truncated number is no number");
eq(callingNumberOf(12197588170), null, "a value of the wrong type is no number");

// --- the batch reader ----------------------------------------------------------
{
  const queries: string[] = [];
  const map = await readLeadCallingNumbers([LEAD_A, LEAD_B, "00QUi00000ZZZZZZZZ"], async (soql) => {
    queries.push(soql);
    return [
      { Id: LEAD_A, AssignedRegalPhone__c: "+12197588170" },
      { Id: LEAD_B, AssignedRegalPhone__c: null },
    ];
  });
  eq(queries.length, 1, "one query for a handful of leads");
  assert(/SELECT Id, AssignedRegalPhone__c FROM Lead WHERE Id IN \(/.test(queries[0] ?? ""), "it asks for the calling number field");
  eq(map.get("00QUi000010889Z"), "+12197588170", "a lead with a number answers the number, keyed by the 15 character id");
  assert(map.has("00QUi00000ABCDE") && map.get("00QUi00000ABCDE") === null, "a lead with the field empty answers null");
  assert(!map.has("00QUi00000ZZZZZ"), "a lead Salesforce did not return is absent, not null");
}
{
  const map = await readLeadCallingNumbers([LEAD_A], async () => [{ Id: LEAD_A, AssignedRegalPhone__c: "not a phone" }]);
  eq(map.get("00QUi000010889Z"), null, "an unreadable value reads as no number");
}
{
  let ran = false;
  const map = await readLeadCallingNumbers([], async () => {
    ran = true;
    return [];
  });
  assert(!ran && map.size === 0, "no ids, no query");
}
{
  let threw = "";
  try {
    await readLeadCallingNumbers([LEAD_A], async () => {
      throw new Error("SF query failed: 503");
    });
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  eq(threw, "SF query failed: 503", "a refused query throws, so a failed read never reads as no number");
}

// The XBC reader shares the same field reader, and still answers as it did.
{
  const map = await readLeadXbcs([LEAD_A], async () => [{ Id: LEAD_A, XBC__c: 512 }]);
  eq(map.get("00QUi000010889Z"), "512", "the XBC reader still answers the stored value verbatim");
}

// --- one booking's lead ----------------------------------------------------------
eq(bookingLeadId({ salesforce_id: LEAD_A, external_id: null }), LEAD_A, "an embed booking's lead id is salesforce_id");
eq(bookingLeadId({ salesforce_id: null, external_id: LEAD_B }), LEAD_B, "an API booking's lead id can be external_id");
eq(bookingLeadId({ salesforce_id: " ", external_id: null }), null, "a blank column is no lead id");
{
  let ran = false;
  const n = await readOneCallingNumber("not-a-lead", async () => {
    ran = true;
    return [];
  });
  assert(!ran && n === null, "a value that is not a Lead id is never asked about, and answers null");
}
{
  const n = await readOneCallingNumber(LEAD_A, async () => [{ Id: LEAD_A, AssignedRegalPhone__c: "+12197588170" }]);
  eq(n, "+12197588170", "one lead's number");
  const missing = await readOneCallingNumber(LEAD_A, async () => []);
  eq(missing, null, "a lead Salesforce did not return answers null for this caller, which only shows or omits");
}

// --- the deadline ------------------------------------------------------------------
{
  // The sleep resolves at once, so the read that never settles loses the race.
  const slow = new Promise<string | null>(() => {});
  const got = await withDeadline(slow, 2_500, async () => {});
  eq(got, null, "a read slower than the deadline answers null rather than holding the page");
}
{
  const got = await withDeadline(Promise.resolve("+12197588170"), 2_500, () => new Promise(() => {}));
  eq(got, "+12197588170", "a read inside the deadline answers its value");
}
{
  const got = await withDeadline(Promise.reject(new Error("boom")), 2_500, () => new Promise(() => {}));
  eq(got, null, "a read that fails answers null: the page says nothing about a number");
}

finish();

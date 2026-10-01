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
import { readWithinDeadline, type ScheduleTimer } from "../src/lib/read-within-deadline.ts";
import {
  callingNumberWithinDeadline,
  callingNumberOf,
  readLeadCallingNumbers,
  readOneCallingNumber,
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
// The timer is injected: `fireAtOnce` expires the deadline immediately, `never` never
// does, and both record whether the timer was CLEARED, because a deadline that left
// its timer running holds the isolate open for the full wait after every fast read.
function timers() {
  const state = { set: 0, cleared: 0 };
  const fireAtOnce: ScheduleTimer = (_ms, fire) => {
    state.set += 1;
    queueMicrotask(fire);
    return () => {
      state.cleared += 1;
    };
  };
  const never: ScheduleTimer = () => {
    state.set += 1;
    return () => {
      state.cleared += 1;
    };
  };
  return { state, fireAtOnce, never };
}
// Reported exactly ONCE per read, whichever way it ends: a read that times out and
// rejects later must not report a second time into the logs.
{
  let reject: (e: Error) => void = () => {};
  const late = new Promise<string | null>((_res, rej) => {
    reject = rej;
  });
  const errs: string[] = [];
  const t = timers();
  const got = await readWithinDeadline(() => late, 2_500, (e) => errs.push(String(e)), t.fireAtOnce);
  eq(got, null, "a timed out read answers null");
  reject(new Error("SF query failed: 503"));
  await new Promise((r) => setTimeout(r, 0));
  eq(errs.length, 1, "and reports once, not again when it rejects late");
  assert(/no answer within/.test(errs[0] ?? ""), "the report being the timeout");
}

// The one helper both readers use: null on a failure OR a timeout, and each is
// reported, so "nobody had a number" and "Salesforce was slow or down" stay apart.
{
  const t = timers();
  const errs: string[] = [];
  const slow = await callingNumberWithinDeadline(() => new Promise(() => {}), (e) => errs.push(String(e)), t.fireAtOnce);
  eq(slow, null, "a slow read answers null rather than holding the page");
  assert(errs.length === 1 && /no answer within 2500ms/.test(errs[0]!), "and reports that it ran out of time");
  eq(t.state.cleared, t.state.set, "and its timer is cleared");

  const t2 = timers();
  const errs2: string[] = [];
  const failed = await callingNumberWithinDeadline(
    async () => {
      throw new Error("SF query failed: 503");
    },
    (e) => errs2.push(String(e)),
    t2.never,
  );
  eq(failed, null, "a refused read answers null");
  assert(errs2.length === 1 && /503/.test(errs2[0]!), "and reports why");
  eq(t2.state.cleared, 1, "with its timer cleared");

  const t3 = timers();
  const errs3: string[] = [];
  const ok = await callingNumberWithinDeadline(async () => "+12197588170", (e) => errs3.push(String(e)), t3.never);
  eq(ok, "+12197588170", "a prompt read answers its value");
  eq(errs3.length, 0, "and reports nothing");
  eq(t3.state.cleared, 1, "and clears the timer it no longer needs");
}

finish();

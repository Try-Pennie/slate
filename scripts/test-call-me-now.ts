// Call me now on the inline booker (#3718). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-call-me-now.ts
//
// Slate's first Salesforce WRITE: it sets the Lead's CallMeNow__c and
// Call_Me_Now_Pending__c, which trypennie.com also sets, and an advisor calls. What
// this file pins:
//  - the button is offered exactly when trypennie offers it (the WebsiteConfiguration__c
//    switch on, "Call Me Now Button" chosen, the lead's ADV at or over the minimum),
//    and an unreadable switch or ADV HIDES it rather than guessing;
//  - nothing is written for a lead id the visitor cannot tie to themselves: the email
//    or phone the page prefilled must match the Lead, unlike trypennie's endpoint,
//    which accepts any id;
//  - a lead with a call already pending is not asked for a second one;
//  - a refusal and a failure stay apart, because Try again can only help a failure
//    (L111), and a failure names the step that failed (L11).
import {
  CALL_ME_NOW_ALTERNATE,
  callMeNowOffered,
  checkCallMeNow,
  formatCallMeNowFailedAlert,
  contactMatchesLead,
  leadFromRecord,
  requestCallMeNow,
  retryCanHelp,
  switchFromRecord,
  type CallMeNowDeps,
  type CallMeNowLead,
  type CallMeNowSwitch,
} from "../src/lib/salesforce/call-me-now.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const LEAD = "00QUi000010889ZMAQ";
const ON: CallMeNowSwitch = { isActiveAlternate: true, pageAlternate: CALL_ME_NOW_ALTERNATE, minimumAdv: 1 };
const LEAD_ROW: CallMeNowLead = {
  email: "maria@example.com",
  phones: ["+1 (219) 758-8170"],
  adv: 3,
  pending: false,
};

// --- when the button is offered, as trypennie's calculateBookingPageVariant decides --
eq(callMeNowOffered(ON, 3), true, "switch on, Call Me Now chosen, ADV over the minimum: offered");
eq(callMeNowOffered(ON, 1), true, "an ADV equal to the minimum is offered, as trypennie's <= reads");
eq(callMeNowOffered(ON, 0), false, "an ADV under the minimum is not offered");
eq(callMeNowOffered({ ...ON, isActiveAlternate: false }, 3), false, "the switch off hides it");
eq(callMeNowOffered({ ...ON, pageAlternate: "Dial-In Number" }, 3), false, "the dial in alternate hides it");
eq(callMeNowOffered({ ...ON, isActiveAlternate: null }, 3), false, "an unreadable switch hides it rather than guessing");
eq(callMeNowOffered({ ...ON, minimumAdv: null }, 3), false, "an unreadable minimum hides it");
eq(callMeNowOffered(ON, null), false, "an unreadable ADV hides it");

// --- reading the two records --------------------------------------------------------
eq(
  switchFromRecord({ IsActiveAlternate__c: true, PageAlternate__c: "Call Me Now Button", MinimumAdv__c: "1" }),
  ON,
  "the configuration record reads as stored, the text minimum as a number",
);
eq(switchFromRecord({ IsActiveAlternate__c: "yes", PageAlternate__c: 4, MinimumAdv__c: "" }), {
  isActiveAlternate: null,
  pageAlternate: null,
  minimumAdv: null,
}, "a field of the wrong type, or a blank minimum, reads as unknown rather than a default");
eq(
  leadFromRecord({ Id: LEAD, Email: " Maria@Example.com ", Phone: null, MobilePhone: "2197588170", ADV__c: 3, Call_Me_Now_Pending__c: true }),
  { email: " Maria@Example.com ", phones: ["2197588170"], adv: 3, pending: true },
  "the lead keeps every phone it has, and its ADV and pending flag as stored",
);
eq(
  leadFromRecord({ Id: LEAD, Email: null, Phone: 12, MobilePhone: "", ADV__c: "3", Call_Me_Now_Pending__c: null }),
  { email: null, phones: [], adv: null, pending: null },
  "empty or wrongly typed fields read as absent or unknown",
);

// --- tying the visitor to the lead --------------------------------------------------
eq(contactMatchesLead({ email: "MARIA@example.com ", phone: null }, LEAD_ROW), true, "an email matches whatever its case and spacing");
eq(contactMatchesLead({ email: null, phone: "219.758.8170" }, LEAD_ROW), true, "a phone matches on its ten digits, however it is written");
eq(contactMatchesLead({ email: null, phone: "12197588170" }, LEAD_ROW), true, "a leading country code 1 still matches");
eq(contactMatchesLead({ email: "someone@else.com", phone: "2125550100" }, LEAD_ROW), false, "neither matching is no match");
eq(contactMatchesLead({ email: "", phone: "" }, { ...LEAD_ROW, email: "", phones: [""] }), false, "two blanks never match each other");
eq(contactMatchesLead({ email: null, phone: "758-8170" }, { ...LEAD_ROW, phones: ["7588170"] }), false, "a number short of ten digits never matches");

// --- the request, end to end on fakes -----------------------------------------------
function deps(over: Partial<CallMeNowDeps> = {}) {
  const writes: string[] = [];
  const d: CallMeNowDeps = {
    readLead: async () => LEAD_ROW,
    readSwitch: async () => ON,
    writeRequested: async (id) => {
      writes.push(id);
    },
    ...over,
  };
  return { d, writes };
}
const GIVEN = { leadId: LEAD, email: "maria@example.com", phone: null };

{
  const { d, writes } = deps();
  eq(await requestCallMeNow(GIVEN, d), { kind: "requested" }, "a matching, eligible lead is asked for a call");
  eq(writes, [LEAD], "and exactly one write is made, for that lead");
}
{
  const { d, writes } = deps();
  eq(await requestCallMeNow({ ...GIVEN, leadId: "a0DUl00000QNSvfMAH" }, d), { kind: "refused", reason: "not-a-lead" }, "an id that is not a Lead is refused before Salesforce is asked");
  eq(writes.length, 0, "and nothing is written");
}
{
  let reads = 0;
  const { d, writes } = deps({ readLead: async () => (reads++, null) });
  eq(await requestCallMeNow(GIVEN, d), { kind: "refused", reason: "no-such-lead" }, "a lead Salesforce does not hold is refused");
  eq(reads, 1, "after one read");
  eq(writes.length, 0, "and nothing is written");
}
{
  const { d, writes } = deps();
  eq(await requestCallMeNow({ ...GIVEN, email: null, phone: null }, d), { kind: "refused", reason: "no-contact" }, "a page that passed no email or phone is refused as such, not as a mismatch");
  eq(writes.length, 0, "and nothing is written");
}
{
  let switchReads = 0;
  const { d, writes } = deps({ readSwitch: async () => (switchReads++, ON) });
  eq(await requestCallMeNow({ ...GIVEN, email: "someone@else.com" }, d), { kind: "refused", reason: "contact-mismatch" }, "a lead id with somebody else's contact is refused");
  eq(writes.length, 0, "and nothing is written");
  eq(switchReads, 0, "and the switch is never read for them, so a guessed id learns nothing about it");
}
{
  const { d, writes } = deps({ readSwitch: async () => ({ ...ON, isActiveAlternate: false }) });
  eq(await requestCallMeNow(GIVEN, d), { kind: "refused", reason: "not-offered" }, "a press after the switch went off is refused");
  eq(writes.length, 0, "and nothing is written");
}
{
  const { d, writes } = deps({ readLead: async () => ({ ...LEAD_ROW, pending: true }) });
  eq(await requestCallMeNow(GIVEN, d), { kind: "already-requested" }, "a lead whose call is already pending is told so");
  eq(writes.length, 0, "and is not asked for a second one");
}
{
  const boom = new Error("SF query failed: 503");
  const { d, writes } = deps({ readLead: async () => { throw boom; } });
  const out = await requestCallMeNow(GIVEN, d);
  eq(out, { kind: "failed", stage: "lead-read", error: boom }, "a failed lead read is a failure naming that step");
  eq(writes.length, 0, "and nothing is written");
}
{
  const boom = new Error("SF query failed: 503");
  const { d } = deps({ readSwitch: async () => { throw boom; } });
  eq(await requestCallMeNow(GIVEN, d), { kind: "failed", stage: "switch-read", error: boom }, "a failed switch read is a failure naming that step");
}
{
  const boom = new Error("SF update failed: 500");
  const { d } = deps({ writeRequested: async () => { throw boom; } });
  eq(await requestCallMeNow(GIVEN, d), { kind: "failed", stage: "write", error: boom }, "a refused write is a failure, never a request");
}

// --- whether to show the button, without writing ----------------------------------
{
  const { d, writes } = deps();
  eq(await checkCallMeNow(GIVEN, d), { kind: "offered" }, "a matching, eligible lead is offered the button");
  eq(writes.length, 0, "and checking writes nothing");
}
{
  const { d } = deps({ readLead: async () => ({ ...LEAD_ROW, pending: true }) });
  eq(await checkCallMeNow(GIVEN, d), { kind: "offered" }, "a pending lead still sees the button; pressing it says the call is on its way");
}
{
  const { d } = deps();
  eq(await checkCallMeNow({ ...GIVEN, email: "someone@else.com" }, d), { kind: "refused", reason: "contact-mismatch" }, "the check refuses a mismatch the same way the request does");
}

// --- which outcomes Try again can help ----------------------------------------------
eq(retryCanHelp({ kind: "failed", stage: "write", error: new Error("x") }), true, "a failure may clear, so Try again is offered");
for (const reason of ["not-a-lead", "no-such-lead", "no-contact", "contact-mismatch", "not-offered"] as const) {
  eq(retryCanHelp({ kind: "refused", reason }), false, `a ${reason} refusal can never be changed by retrying`);
}
assert(!retryCanHelp({ kind: "requested" }) && !retryCanHelp({ kind: "already-requested" }), "a success offers no retry");

// --- the page when a press did not go through ---------------------------------------
{
  const text = formatCallMeNowFailedAlert({
    stage: "write",
    leadId: LEAD,
    error: new Error('SF update failed: 503 [{"errorCode":"SERVER_UNAVAILABLE","message":"long json body here"}]'),
  });
  assert(text.includes(LEAD), "the page names the lead, whose id is safe to show");
  assert(/marking the lead for a call/.test(text), "and the step that failed, in words");
  assert(!text.includes("errorCode"), "never Salesforce's raw JSON");
  assert(/nobody has been asked to call/i.test(text), "and says plainly that no call is coming");
  assert(!/^Slate/.test(text), "and does not open with Slate's own name");
}
for (const [stage, words] of [
  ["lead-read", /reading the lead/],
  ["switch-read", /reading the Call me now switch/],
] as const) {
  assert(words.test(formatCallMeNowFailedAlert({ stage, leadId: LEAD, error: new Error("x") })), `the ${stage} step is named as such`);
}

finish();

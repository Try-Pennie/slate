// The Lead id an advisor link booking takes from the lead's earlier bookings when
// its link carried none (#3739): strict on the match, never a guess on a conflict,
// and the provenance key owned by the server.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-lead-id-from-bookings.ts
import {
  LEAD_ID_FROM_KEY,
  leadIdFromEarlierBookings,
  withLeadIdFrom,
  type EarlierLeadBookingRow,
} from "../src/lib/booking/lead-id-from-bookings.ts";
import { assert, finish } from "./lib/harness.ts";

const LEAD_A_18 = "00Q8c00001AbCdEFGH";
const LEAD_A_15 = LEAD_A_18.slice(0, 15);
const LEAD_B_18 = "00Q8c00001ZyXwVUTS";
const contact = { email: "Kris@Example.com", phone: "(203) 561-5295" };

function row(over: Partial<EarlierLeadBookingRow>): EarlierLeadBookingRow {
  return {
    id: "e1",
    created_at: "2026-10-04T12:00:00Z",
    salesforce_id: LEAD_A_18,
    external_id: null,
    attendee_email: "kris@example.com",
    attendee_phone: "+12035615295",
    assigned_user_id: "other",
    ...over,
  };
}

// One earlier booking on both email and phone: its id, case and format aside.
{
  const got = leadIdFromEarlierBookings(contact, "adv", [row({})]);
  assert(got.kind === "found" && got.leadId === LEAD_A_18, "an earlier booking matching email AND phone supplies its Lead id");
  assert(got.kind === "found" && got.sameAdvisor === false, "a booking with another advisor is still evidence, recorded as not the same advisor");
}
{
  const got = leadIdFromEarlierBookings(contact, "adv", [row({ assigned_user_id: "adv" })]);
  assert(got.kind === "found" && got.sameAdvisor, "an earlier booking with this same advisor is recorded as the strongest evidence");
}

// Strict: email alone or phone alone never supplies an id.
{
  const emailOnly = leadIdFromEarlierBookings(contact, "adv", [row({ attendee_phone: "+12035550000" })]);
  assert(emailOnly.kind === "none", "the same email with a different phone supplies nothing");
  const phoneOnly = leadIdFromEarlierBookings(contact, "adv", [row({ attendee_email: "someone@else.com" })]);
  assert(phoneOnly.kind === "none", "the same phone with a different email supplies nothing");
  const sameAdvisorWeak = leadIdFromEarlierBookings(contact, "adv", [row({ attendee_phone: null, assigned_user_id: "adv" })]);
  assert(sameAdvisorWeak.kind === "none", "the same advisor never relaxes the match to email alone");
}

// A contact with no email or no phone matches nothing, even a row with blanks.
{
  assert(leadIdFromEarlierBookings({ email: "", phone: contact.phone }, "adv", [row({ attendee_email: "" })]).kind === "none", "no email, no match");
  assert(leadIdFromEarlierBookings({ email: contact.email, phone: null }, "adv", [row({ attendee_phone: null })]).kind === "none", "no phone, no match");
}

// Never a guess: two Lead ids is a conflict, and saves none.
{
  const got = leadIdFromEarlierBookings(contact, "adv", [
    row({ id: "e1" }),
    row({ id: "e2", salesforce_id: LEAD_B_18, assigned_user_id: "adv" }),
  ]);
  assert(got.kind === "conflict" && got.leadIdCount === 2, "two earlier bookings with different Lead ids are a conflict, even when one is the same advisor");
  assert(got.kind === "conflict" && got.bookingIds.join(",") === "e1,e2", "the conflict names both bookings for the log");
}

// One Lead spelled two ways is one Lead, saved under its 18 character spelling.
{
  const got = leadIdFromEarlierBookings(contact, "adv", [
    row({ id: "e1", salesforce_id: LEAD_A_15 }),
    row({ id: "e2", salesforce_id: null, external_id: LEAD_A_18 }),
  ]);
  assert(got.kind === "found" && got.leadId === LEAD_A_18, "a 15 and an 18 character spelling of one Lead agree, saved as the 18 held");
}
{
  const got = leadIdFromEarlierBookings(contact, "adv", [row({ salesforce_id: LEAD_A_15 })]);
  assert(got.kind === "found" && got.leadId.length === 18 && got.leadId.startsWith(LEAD_A_15), "a 15 character id alone is saved as its computed 18 character spelling");
}

// Only a real Lead id: an API caller's own external id is not one.
{
  const got = leadIdFromEarlierBookings(contact, "adv", [row({ salesforce_id: null, external_id: "partner-123" })]);
  assert(got.kind === "none", "a non Lead external id is never saved as a Salesforce id");
  const mixed = leadIdFromEarlierBookings(contact, "adv", [
    row({ id: "e1" }),
    row({ id: "e2", salesforce_id: null, external_id: "partner-123" }),
  ]);
  assert(mixed.kind === "found" && mixed.leadId === LEAD_A_18, "a non Lead id beside a Lead id is not a conflict");
}

// The provenance key is the server's alone.
{
  const posted = { source: "agent-direct", [LEAD_ID_FROM_KEY]: "earlier-booking" };
  const none = withLeadIdFrom(posted, null);
  assert(!(LEAD_ID_FROM_KEY in none) && none.source === "agent-direct", "a posted leadIdFrom is dropped when the server inferred nothing");
  assert(posted[LEAD_ID_FROM_KEY] === "earlier-booking", "the posted prefill is not mutated");
  const inferred = withLeadIdFrom({ source: "agent-direct", [LEAD_ID_FROM_KEY]: "link" }, "earlier-booking");
  assert(inferred[LEAD_ID_FROM_KEY] === "earlier-booking", "the server's own value replaces a posted one");
  assert(Object.keys(withLeadIdFrom({}, null)).length === 0, "an empty prefill with nothing to record stays empty");
  assert(withLeadIdFrom({}, "link")[LEAD_ID_FROM_KEY] === "link", "a link id is recorded even with nothing else posted");
  assert(Object.keys(withLeadIdFrom(undefined, null)).length === 0, "a confirm that posted no prefill at all is saved with an empty one, never a crash");
}

finish();

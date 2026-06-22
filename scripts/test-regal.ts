// Sanity test for the Regal event builder.
// Run: node --experimental-strip-types scripts/test-regal.ts
import { buildRegalEvent } from "../src/lib/webhooks/regal.ts";
import type { BookingEventPayload } from "../src/lib/webhooks/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const payload: BookingEventPayload = {
  booking_id: "11111111-1111-1111-1111-111111111111",
  salesforce_id: "a04Ui00000HnjwfIAB",
  bucket_code: "411",
  event_type: "Senior Loan Advisor Call",
  event_type_slug: "call",
  event_description: "Twenty minutes with a senior advisor…",
  status: "confirmed",
  starts_at: "2026-06-08T13:00:00.000Z", // 09:00 ET (EDT)
  ends_at: "2026-06-08T13:30:00.000Z",
  timezone: "America/New_York",
  agent: { id: "a", name: "Jane Agent", email: "jane@trypennie.com" },
  attendee: {
    name: "Kristina Kelly",
    email: "kristinakelly17@gmail.com",
    phone: "+12035615295",
  },
  prefill: { xbc: "411", loanRequest: "160000" },
  manage_url: "https://slate.app/booking/manage/tok123",
  reason: null,
};

const created = buildRegalEvent("booking.created", payload);

assert(created.name === "Slate Booking Created", "event name maps to Slate Booking Created");
assert(created.eventSource === "slate", "eventSource is slate");
assert(created.properties.type === "call", "type uses the regal_type slug");
assert(created.properties.eventTitle === "Senior Loan Advisor Call", "eventTitle is the event type name");
assert(created.properties.description === payload.event_description, "description carried from event type");
assert(created.properties.ownerEmail === "jane@trypennie.com", "ownerEmail is the agent email");
assert(created.properties.agentName === "Jane Agent", "agentName is the agent full name");
assert(created.properties.bookingId === payload.booking_id, "bookingId is the Slate UUID");
assert(created.properties.salesforceId === "a04Ui00000HnjwfIAB", "salesforceId carried");
assert(created.properties.slateBookingLink === payload.manage_url, "slateBookingLink is manage_url");
assert(created.properties.location === "Phone Call", "location hardcoded to Phone Call");
assert(created.properties.slateBookingTimeZone === "ET", "tz abbreviation normalized to ET");
assert(created.properties.slateBookingDayOfWeek === "Monday", "day of week computed in attendee tz");
assert(created.properties.slateBookingLocalTime === "09:00 AM", "local time 09:00 AM in ET");
assert(created.properties.slateBookingDate === "2026-06-08", "local date in ET");
assert(created.properties.status === "ACCEPTED", "confirmed maps to ACCEPTED");
assert(created.traits.firstName === "Kristina" && created.traits.lastName === "Kelly", "name split into traits");
assert(
  JSON.stringify(created.traits.phones) ===
    JSON.stringify({ "+12035615295": { voiceOptIn: { subscribed: true }, smsOptIn: { subscribed: true } } }),
  "created phone trait has voice+sms opt-in",
);
assert(
  JSON.stringify(created.traits.emails) ===
    JSON.stringify({ "kristinakelly17@gmail.com": { emailOptIn: { subscribed: true } } }),
  "created email trait has email opt-in",
);

const cancelled = buildRegalEvent("booking.cancelled", { ...payload, status: "cancelled" });
assert(cancelled.name === "Slate Booking Cancelled", "cancel event name");
assert(cancelled.properties.status === "CANCELLED", "cancelled maps to CANCELLED");
assert(
  JSON.stringify(cancelled.traits.phones) === JSON.stringify({ "+12035615295": {} }),
  "non-created phone trait has no opt-in",
);
assert("cancelledBy" in cancelled.properties, "cancel includes cancelledBy property");
// No reason on the payload -> the reason properties are null (not omitted).
assert(cancelled.properties.cancellationReason === null, "cancel reason null when payload has none");

// #326: a captured reason flows through to the Regal payload (the consumer).
const cancelledWithReason = buildRegalEvent("booking.cancelled", {
  ...payload,
  status: "cancelled",
  reason: { code: "booked_by_mistake", detail: null, initiator: "customer" },
});
assert(cancelledWithReason.properties.cancellationReason === "booked_by_mistake", "cancel reason code maps to cancellationReason");
assert(cancelledWithReason.properties.cancelledBy === "customer", "cancel initiator maps to cancelledBy");

const resched = buildRegalEvent("booking.rescheduled", { ...payload, status: "rescheduled" });
assert(resched.properties.rescheduleId === payload.booking_id, "reschedule includes rescheduleId");

const reschedWithReason = buildRegalEvent("booking.rescheduled", {
  ...payload,
  status: "rescheduled",
  reason: { code: "found_better_time", detail: "earlier slot opened up", initiator: "customer" },
});
assert(reschedWithReason.properties.rescheduleReason === "found_better_time", "reschedule reason code maps to rescheduleReason");
assert(reschedWithReason.properties.rescheduleReasonDetail === "earlier slot opened up", "reschedule detail maps through");
assert(reschedWithReason.properties.rescheduledBy === "customer", "reschedule initiator maps to rescheduledBy");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

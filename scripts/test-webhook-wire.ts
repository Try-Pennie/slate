// Sanity test for the outbound webhook wire format, incl. the delivery-id
// idempotency contract (#32).
// Run: node --experimental-strip-types scripts/test-webhook-wire.ts
import { createHmac } from "node:crypto";
import { buildRequest, sign } from "../src/lib/webhooks/wire.ts";
import type { BookingEventPayload } from "../src/lib/webhooks/types.ts";
import type { WebhookEndpoint } from "../src/lib/db/types.ts";
import { assert, finish } from "./lib/harness.ts";

const payload: BookingEventPayload = {
  booking_id: "b-1",
  salesforce_id: "sf-1",
  bucket_code: "411",
  event_type: "Senior Loan Advisor Call",
  event_type_slug: "senior-loan-advisor",
  event_description: null,
  starts_at: "2026-06-25T13:00:00.000Z",
  ends_at: "2026-06-25T13:20:00.000Z",
  timezone: "America/New_York",
  status: "confirmed",
  agent: { name: "Agent A", email: "a@trypennie.com" },
  attendee: { name: "Dana Lead", email: "dana@example.com", phone: "+12035615295" },
  manage_url: "https://slate.trypennie.app/booking/manage/tok",
};

const regalEndpoint = {
  id: "ep-1",
  format: "regal",
  url: "https://events.regalvoice.com/events",
  auth_header: "regal-key",
  secret: "unused-for-regal",
} as unknown as WebhookEndpoint;

const genericEndpoint = {
  id: "ep-2",
  format: "generic",
  url: "https://example.com/hook",
  auth_header: null,
  secret: "s3cret",
} as unknown as WebhookEndpoint;

const DELIVERY = "d-12345";
const TS = "2026-06-11T18:00:00.000Z";

// --- regal format ---
const regal = buildRequest(regalEndpoint, DELIVERY, "booking.created", payload, TS);
assert(
  regal.headers["x-slate-delivery-id"] === DELIVERY,
  "regal: x-slate-delivery-id header carries the delivery row id",
);
assert(regal.headers.authorization === "regal-key", "regal: auth header preserved");
const regalBody = JSON.parse(regal.body);
assert(
  regalBody.properties.slateDeliveryId === DELIVERY,
  "regal: properties.slateDeliveryId set (journeys see properties, not headers)",
);
assert(regalBody.name === "Slate Booking Created", "regal: event name intact");
assert(regalBody.properties.bookingId === "b-1", "regal: existing properties intact");

// Retries must reuse the SAME id (idempotency across attempts).
const retry = buildRequest(regalEndpoint, DELIVERY, "booking.created", payload, TS);
assert(
  JSON.parse(retry.body).properties.slateDeliveryId === DELIVERY,
  "regal: a retry of the same delivery carries the same id",
);

// --- generic format ---
const generic = buildRequest(genericEndpoint, DELIVERY, "booking.created", payload, TS);
assert(
  generic.headers["x-slate-delivery-id"] === DELIVERY,
  "generic: x-slate-delivery-id header carries the delivery row id",
);
assert(generic.headers["x-slate-event"] === "booking.created", "generic: event header intact");
assert(generic.headers["x-slate-timestamp"] === TS, "generic: timestamp header intact");
const expectedSig =
  "sha256=" +
  createHmac("sha256", "s3cret").update(`${TS}.${generic.body}`).digest("hex");
assert(
  generic.headers["x-slate-signature"] === expectedSig,
  "generic: signature still verifies over timestamp.body",
);
assert(
  sign("s3cret", `${TS}.${generic.body}`) === expectedSig,
  "generic: exported sign() matches",
);
const genericBody = JSON.parse(generic.body);
assert(
  genericBody.event === "booking.created" && genericBody.data.booking_id === "b-1",
  "generic: body stays {event, data} (delivery id is header-only here)",
);
assert(
  !("slateDeliveryId" in genericBody) && !("delivery_id" in genericBody),
  "generic: body unchanged by the delivery id (signature compatibility)",
);

// --- #600: a Regal endpoint with no API key must FAIL LOUDLY ---
// The Regal API key IS the authentication. Sending `authorization: ""` posts an
// unauthenticated event that Regal rejects, and the old `?? ""` swallow made that
// look like a normal delivery attempt rather than the misconfiguration it is. An
// admin who saved the webhook form without retyping the key could silently take
// every booking event offline this way.
let threw = false;
try {
  buildRequest(
    { ...regalEndpoint, auth_header: null } as WebhookEndpoint,
    DELIVERY,
    "booking.created",
    payload,
    TS,
  );
} catch {
  threw = true;
}
assert(threw, "regal: buildRequest THROWS when auth_header is missing, never sends an empty Authorization (#600)");

let threwOnBlank = false;
try {
  buildRequest(
    { ...regalEndpoint, auth_header: "   " } as WebhookEndpoint,
    DELIVERY,
    "booking.created",
    payload,
    TS,
  );
} catch {
  threwOnBlank = true;
}
assert(threwOnBlank, "regal: a whitespace-only key is treated as missing, not as a key (#600)");

finish();

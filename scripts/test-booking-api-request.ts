// Request parsing/validation for the direct booking API (#356). Pure so it runs
// under `node --experimental-strip-types`. Validates the machine caller's body:
// strict attendee (name+email+phone, same rules as the embed), a REAL IANA
// timezone (a bot may send "EST"/""), a parseable ISO start, and a required
// external_id (the bot's stable per-person id). Normalizes (trims, defaults
// prefill) so the booking layer gets clean input.
// Run: node --experimental-strip-types scripts/test-booking-api-request.ts
import { parseDirectBookingRequest } from "../src/lib/booking/api-request.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const valid = {
  bucketCode: "411",
  start: "2026-07-01T15:00:00.000Z",
  timezone: "America/New_York",
  attendee: { name: "  Dana Lee ", email: " dana@example.com ", phone: " 215-555-0100 " },
  salesforceId: "00Q5x000001abcEAA",
  prefill: { utm_source: "regal" },
  externalId: "lead-abc-123",
};

// --- happy path: accepted + normalized ---
{
  const r = parseDirectBookingRequest(valid);
  assert(r.ok === true, "a complete, well-formed request is accepted");
  if (r.ok) {
    assert(r.value.bucketCode === "411", "bucketCode preserved");
    assert(r.value.startIso === "2026-07-01T15:00:00.000Z", "start surfaced as startIso");
    assert(r.value.timezone === "America/New_York", "valid IANA timezone preserved");
    assert(r.value.attendee.name === "Dana Lee", "attendee name trimmed");
    assert(r.value.attendee.email === "dana@example.com", "attendee email trimmed");
    assert(r.value.attendee.phone === "215-555-0100", "attendee phone trimmed");
    assert(r.value.salesforceId === "00Q5x000001abcEAA", "salesforceId preserved");
    assert(r.value.externalId === "lead-abc-123", "externalId preserved");
    assert(r.value.prefill.utm_source === "regal", "prefill preserved");
  }
}

// --- external_id is REQUIRED for the API (unlike the embed) ---
for (const bad of [undefined, "", "   "]) {
  const r = parseDirectBookingRequest({ ...valid, externalId: bad });
  assert(r.ok === false && r.status === 400, `externalId ${JSON.stringify(bad)} -> 400`);
}

// --- timezone must be a real IANA zone ---
for (const tz of ["", "Mars/Phobos", "GMT+5", "not a zone"]) {
  const r = parseDirectBookingRequest({ ...valid, timezone: tz });
  assert(r.ok === false && r.status === 400, `non-IANA timezone ${JSON.stringify(tz)} -> 400`);
}
assert(
  parseDirectBookingRequest({ ...valid, timezone: "Europe/London" }).ok === true,
  "another valid IANA timezone is accepted",
);
// "EST" is a legacy fixed-offset IANA zone (valid). The start is an absolute UTC
// instant, so the timezone only drives the gcal event's DISPLAY zone, never the
// actual meeting instant — so accepting it is not a correctness risk.
assert(
  parseDirectBookingRequest({ ...valid, timezone: "EST" }).ok === true,
  "a legacy fixed-offset IANA zone (EST) is accepted",
);

// --- start must be a parseable instant ---
for (const start of ["not-a-date", "", "2026-13-45T99:99:99Z"]) {
  const r = parseDirectBookingRequest({ ...valid, start });
  assert(r.ok === false && r.status === 400, `unparseable start ${JSON.stringify(start)} -> 400`);
}

// --- strict attendee: all three required, with field-level errors ---
{
  const noEmail = parseDirectBookingRequest({
    ...valid,
    attendee: { name: "Dana", email: "", phone: "2155550100" },
  });
  assert(noEmail.ok === false, "missing email -> rejected");
  if (!noEmail.ok) assert(!!noEmail.fieldErrors?.email, "missing email -> field error on email");

  const badEmail = parseDirectBookingRequest({
    ...valid,
    attendee: { name: "Dana", email: "nope", phone: "2155550100" },
  });
  assert(badEmail.ok === false, "malformed email -> rejected");

  const noPhone = parseDirectBookingRequest({
    ...valid,
    attendee: { name: "Dana", email: "d@e.com", phone: "" },
  });
  assert(noPhone.ok === false, "missing phone -> rejected");

  const noName = parseDirectBookingRequest({
    ...valid,
    attendee: { name: "", email: "d@e.com", phone: "2155550100" },
  });
  assert(noName.ok === false, "missing name -> rejected");
}

// --- bucketCode required ---
{
  const r = parseDirectBookingRequest({ ...valid, bucketCode: "" });
  assert(r.ok === false && r.status === 400, "blank bucketCode -> 400");
}

// --- prefill defaults to {} and rejects non-string values ---
{
  const noPrefill = parseDirectBookingRequest({ ...valid, prefill: undefined });
  assert(noPrefill.ok === true, "omitted prefill is allowed");
  if (noPrefill.ok)
    assert(
      JSON.stringify(noPrefill.value.prefill) === "{}",
      "omitted prefill defaults to {}",
    );

  const badPrefill = parseDirectBookingRequest({
    ...valid,
    prefill: { n: 5 } as unknown,
  });
  assert(badPrefill.ok === false, "non-string prefill value -> rejected");
}

// --- garbage bodies ---
for (const body of [null, undefined, "string", 42, []]) {
  const r = parseDirectBookingRequest(body);
  assert(r.ok === false && r.status === 400, `non-object body ${JSON.stringify(body)} -> 400`);
}

// --- salesforceId is optional -> null when absent ---
{
  const { salesforceId: _omit, ...noSf } = valid;
  const r = parseDirectBookingRequest(noSf);
  assert(r.ok === true, "salesforceId is optional");
  if (r.ok) assert(r.value.salesforceId === null, "absent salesforceId normalizes to null");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

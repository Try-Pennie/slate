// Request parsing/validation for the direct booking API (#356). Pure so it runs
// under `node --experimental-strip-types`. Validates the machine caller's body:
// strict attendee (name+email+phone, same rules as the embed), a REAL IANA
// timezone (a bot may send "EST"/""), a parseable ISO start, and a required
// external_id (the bot's stable per-person id). Normalizes (trims, defaults
// prefill) so the booking layer gets clean input.
// Run: node --experimental-strip-types scripts/test-booking-api-request.ts
import { parseDirectBookingRequest, parseLookupQuery, parseCancelQuery, parseCancelBody, parseListQuery, encodeCursor, decodeCursor } from "../src/lib/booking/api-request.ts";
import { CANCEL_REASONS } from "../src/lib/booking/core.ts";
import { assert, finish } from "./lib/harness.ts";

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

// --- #3495: the tier the caller had on show, a measure only ---
// Sent, the confirm records it instead of reading the availability cache for it.
// Anything that is not a tier name is dropped rather than refusing the booking,
// because a lead must never lose a call over a field only /admin/routing reads.
{
  const r = parseDirectBookingRequest({ ...valid, shownTier: "very_high" });
  assert(r.ok && r.value.shownTier === "very_high", "a tier name the caller had on show is passed through (#3495)");
  for (const bad of ["Very High", "nonsense", 4, "", null, { key: "high" }]) {
    const b = parseDirectBookingRequest({ ...valid, shownTier: bad });
    assert(b.ok && b.value.shownTier === undefined, `an unreadable shownTier (${JSON.stringify(bad)}) is dropped and the booking still parses (#3495)`);
  }
  const none = parseDirectBookingRequest(valid);
  assert(none.ok && none.value.shownTier === undefined, "a caller that sends no tier hands none on, so the confirm reads it as before (#3495)");
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

// --- start must carry an explicit timezone offset (#358): a bare local time
// would be read as server time and could book the wrong hour. ---
for (const start of ["2026-07-01T15:00:00", "2026-07-01T15:00:00.000", "2026-07-01"]) {
  const r = parseDirectBookingRequest({ ...valid, start });
  assert(r.ok === false && r.status === 400, `zoneless start ${JSON.stringify(start)} -> 400`);
}
for (const start of ["2026-07-01T15:00:00Z", "2026-07-01T15:00:00-04:00", "2026-07-01T15:00:00+0000"]) {
  assert(
    parseDirectBookingRequest({ ...valid, start }).ok === true,
    `start with explicit offset ${JSON.stringify(start)} is accepted`,
  );
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

// --- size caps (#1034): reject oversized fields before insert ---
{
  const longBucket = parseDirectBookingRequest({ ...valid, bucketCode: "a".repeat(65) });
  assert(longBucket.ok === false && longBucket.status === 400, "over-64-char bucketCode -> 400");

  const longTz = parseDirectBookingRequest({ ...valid, timezone: "a".repeat(65) });
  assert(longTz.ok === false && longTz.status === 400, "over-64-char timezone -> 400");

  const longSf = parseDirectBookingRequest({ ...valid, salesforceId: "a".repeat(129) });
  assert(longSf.ok === false && longSf.status === 400, "over-128-char salesforceId -> 400");

  const longExt = parseDirectBookingRequest({ ...valid, externalId: "a".repeat(129) });
  assert(longExt.ok === false && longExt.status === 400, "over-128-char externalId -> 400");

  const bigValue = parseDirectBookingRequest({ ...valid, prefill: { k: "v".repeat(501) } });
  assert(bigValue.ok === false && bigValue.status === 400, "prefill value over 500 chars -> 400");

  const manyKeys = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]));
  const bigPrefill = parseDirectBookingRequest({ ...valid, prefill: manyKeys });
  assert(bigPrefill.ok === false && bigPrefill.status === 400, "prefill with more than 20 keys -> 400");

  const longName = parseDirectBookingRequest({
    ...valid,
    attendee: { ...valid.attendee, name: "a".repeat(201) },
  });
  assert(longName.ok === false && longName.status === 400, "over-200-char attendee name -> 400");
}

// --- garbage bodies ---
for (const body of [null, undefined, "string", 42, []]) {
  const r = parseDirectBookingRequest(body);
  assert(r.ok === false && r.status === 400, `non-object body ${JSON.stringify(body)} -> 400`);
}

// --- dryRun defaults false, accepts true (#380) ---
{
  const def = parseDirectBookingRequest(valid);
  assert(def.ok === true && def.value.dryRun === false, "dryRun defaults to false");
  const on = parseDirectBookingRequest({ ...valid, dryRun: true });
  assert(on.ok === true && on.value.dryRun === true, "dryRun: true is accepted");
}

// --- external_id IS the lead's Salesforce id (#363/#377): when salesforceId is
// not sent separately, default it from external_id so cross-channel dedupe
// matches an API booking against a website booking via salesforce_id. ---
{
  const { salesforceId: _omit, ...noSf } = valid;
  const r = parseDirectBookingRequest(noSf);
  assert(r.ok === true, "salesforceId is optional");
  if (r.ok)
    assert(
      r.value.salesforceId === valid.externalId,
      `absent salesforceId defaults to external_id (got ${r.ok ? r.value.salesforceId : "?"})`,
    );

  // An explicitly-sent salesforceId is preserved (it's the same value anyway).
  const explicit = parseDirectBookingRequest({ ...valid, externalId: "EXT9", salesforceId: "SF9" });
  assert(
    explicit.ok === true && explicit.value.salesforceId === "SF9",
    "an explicit salesforceId is kept as-is",
  );
}

// --- parseLookupQuery (#386) ---
const lqOk = parseLookupQuery(new URLSearchParams("externalId=ext-1"));
assert(lqOk.ok && lqOk.value.externalId === "ext-1" && lqOk.value.bookingId === null && lqOk.value.status === null,
  "lookup: externalId only is valid, no bookingId/status");
const lqMiss = parseLookupQuery(new URLSearchParams(""));
assert(!lqMiss.ok && lqMiss.status === 400, "lookup: missing externalId = 400");
const lqId = parseLookupQuery(new URLSearchParams("externalId=ext-1&bookingId=bk-7&status=confirmed"));
assert(lqId.ok && lqId.value.bookingId === "bk-7" && lqId.value.status === "confirmed",
  "lookup: bookingId + valid status parsed");
const lqBadStatus = parseLookupQuery(new URLSearchParams("externalId=ext-1&status=pending"));
assert(!lqBadStatus.ok && lqBadStatus.status === 400, "lookup: unknown status = 400");

// --- parseCancelQuery (#386) ---
const cqOk = parseCancelQuery(new URLSearchParams("bookingId=bk-7&externalId=ext-1"), CANCEL_REASONS);
assert(cqOk.ok && cqOk.value.bookingId === "bk-7" && cqOk.value.externalId === "ext-1" && cqOk.value.reason === null,
  "cancel: bookingId + externalId valid, reason defaults null");
const cqNoBooking = parseCancelQuery(new URLSearchParams("externalId=ext-1"), CANCEL_REASONS);
assert(!cqNoBooking.ok && cqNoBooking.status === 400, "cancel: missing bookingId = 400");
const cqNoId = parseCancelQuery(new URLSearchParams("bookingId=bk-7"), CANCEL_REASONS);
assert(!cqNoId.ok && cqNoId.status === 400, "cancel: missing both ids = 400");
const cqReason = parseCancelQuery(new URLSearchParams("bookingId=bk-7&salesforceId=sf-9&reason=no_longer_interested"), CANCEL_REASONS);
assert(cqReason.ok && cqReason.value.reason?.code === "no_longer_interested",
  "cancel: valid reason code accepted");
const cqBadReason = parseCancelQuery(new URLSearchParams("bookingId=bk-7&externalId=ext-1&reason=not_a_reason"), CANCEL_REASONS);
assert(!cqBadReason.ok && cqBadReason.status === 400, "cancel: invalid reason = 400");

// --- parseCancelBody (#2591): the POST form, because a Regal journey cannot send DELETE ---
const cbOk = parseCancelBody({ bookingId: " bk-7 ", salesforceId: "sf-9" }, CANCEL_REASONS);
assert(cbOk.ok && cbOk.value.bookingId === "bk-7" && cbOk.value.salesforceId === "sf-9" &&
  cbOk.value.externalId === null && cbOk.value.reason === null,
  "cancel body: bookingId + salesforceId valid and trimmed, reason defaults null");
for (const [label, body] of [
  ["null (unparseable JSON)", null],
  ["an array", ["bk-7"]],
  ["a string", "bk-7"],
] as const) {
  const r = parseCancelBody(body, CANCEL_REASONS);
  assert(!r.ok && r.status === 400 && r.error === "body must be a JSON object",
    `cancel body: ${label} = 400 naming the body, not a field`);
}
const cbNoBooking = parseCancelBody({ externalId: "ext-1" }, CANCEL_REASONS);
assert(!cbNoBooking.ok && cbNoBooking.error === "bookingId is required", "cancel body: missing bookingId = 400");
const cbNoId = parseCancelBody({ bookingId: "bk-7" }, CANCEL_REASONS);
assert(!cbNoId.ok && cbNoId.error === "externalId or salesforceId is required", "cancel body: missing both ids = 400");
// A non-string id must read as ABSENT, never be stringified into something that matches.
const cbNumericId = parseCancelBody({ bookingId: "bk-7", externalId: 12345 }, CANCEL_REASONS);
assert(!cbNumericId.ok && cbNumericId.error === "externalId or salesforceId is required",
  "cancel body: a numeric externalId is not an id");
const cbReason = parseCancelBody({ bookingId: "bk-7", externalId: "ext-1", reason: "no_longer_interested" }, CANCEL_REASONS);
assert(cbReason.ok && cbReason.value.reason?.code === "no_longer_interested", "cancel body: valid reason code accepted");
const cbBadReason = parseCancelBody({ bookingId: "bk-7", externalId: "ext-1", reason: "not_a_reason" }, CANCEL_REASONS);
assert(!cbBadReason.ok && cbBadReason.status === 400, "cancel body: invalid reason = 400");
// One rule, two carriers: the same fields must get the same verdict either way.
{
  const q = parseCancelQuery(new URLSearchParams("bookingId=bk-7&externalId=ext-1&reason=other&reasonDetail=moved+away"), CANCEL_REASONS);
  const b = parseCancelBody({ bookingId: "bk-7", externalId: "ext-1", reason: "other", reasonDetail: "moved away" }, CANCEL_REASONS);
  assert(q.ok && b.ok && JSON.stringify(q.value) === JSON.stringify(b.value),
    "cancel: the query form and the body form parse the same fields to the same value");
}

// --- list query parser (#392) ---
assert(decodeCursor(encodeCursor(150)) === 150, "cursor round-trips an offset");
assert(decodeCursor("!!!not-base64-int") === null, "garbage cursor -> null");

const lOk = parseListQuery(new URLSearchParams("status=confirmed&limit=10"));
assert(lOk.ok && lOk.value.status === "confirmed" && lOk.value.limit === 10 && lOk.value.offset === 0,
  "list: status + limit parsed, offset defaults 0");
const lDefault = parseListQuery(new URLSearchParams(""));
assert(lDefault.ok && lDefault.value.limit === 50 && lDefault.value.status === null,
  "list: empty query is valid, default limit 50, no status");
const lClamp = parseListQuery(new URLSearchParams("limit=10000"));
assert(lClamp.ok && lClamp.value.limit === 100, "list: limit clamps to 100");
const lBadStatus = parseListQuery(new URLSearchParams("status=pending"));
assert(!lBadStatus.ok && lBadStatus.status === 400, "list: bad status -> 400");
const lBadDate = parseListQuery(new URLSearchParams("afterStart=2026-07-01T15:00:00"));
assert(!lBadDate.ok && lBadDate.status === 400, "list: zoneless afterStart -> 400");
const lOkDate = parseListQuery(new URLSearchParams("afterStart=2026-07-01T15:00:00Z&updatedSince=2026-06-01T00:00:00Z"));
assert(lOkDate.ok && lOkDate.value.afterStart === "2026-07-01T15:00:00Z" && lOkDate.value.updatedSince === "2026-06-01T00:00:00Z",
  "list: offset-bearing ISO dates accepted");
const lCursor = parseListQuery(new URLSearchParams(`cursor=${encodeCursor(50)}`));
assert(lCursor.ok && lCursor.value.offset === 50, "list: cursor decodes to offset");
const lBadCursor = parseListQuery(new URLSearchParams("cursor=@@@"));
assert(!lBadCursor.ok && lBadCursor.status === 400, "list: bad cursor -> 400");
const lCap = parseListQuery(new URLSearchParams(`cursor=${encodeCursor(20000)}`));
assert(!lCap.ok && lCap.status === 400, "list: offset past 10000 cap -> 400");
const lBucketAgent = parseListQuery(new URLSearchParams("bucket=411&agentEmail=a@x.com"));
assert(lBucketAgent.ok && lBucketAgent.value.bucketCode === "411" && lBucketAgent.value.agentEmail === "a@x.com",
  "list: bucket + agentEmail parsed");

// #2872: a caller holding only a booking id (a host confirmed page whose success
// event carried no lead id) used to land in list mode, which ignored the id and
// answered 200 with the first page of EVERY booking. A page reading the first row
// would show a stranger's call as the lead's own. The id selects one booking, so
// without the lead id it is refused by name rather than ignored.
const lBookingIdOnly = parseListQuery(new URLSearchParams("bookingId=11111111-1111-4111-8111-111111111111"));
assert(!lBookingIdOnly.ok && lBookingIdOnly.status === 400,
  "list: bookingId without externalId -> 400, never the whole list");
assert(!lBookingIdOnly.ok && /bookingId/.test(lBookingIdOnly.error) && /externalId/.test(lBookingIdOnly.error),
  "list: the refusal names bookingId and the externalId it needs");
const lBlankBookingId = parseListQuery(new URLSearchParams("bookingId="));
assert(!lBlankBookingId.ok && lBlankBookingId.status === 400,
  "list: an empty bookingId key is refused too, since its caller meant one booking");
// Positive control: the same query without the id is still an ordinary list.
assert(parseListQuery(new URLSearchParams("status=confirmed")).ok, "list: no bookingId stays a valid list");

finish();

// Sanity test for the shared attendee contact validation (#37).
// Run: node --experimental-strip-types scripts/test-attendee.ts
import { validateAttendee } from "../src/lib/attendee.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const valid = {
  name: "Dana Lead",
  email: "dana@example.com",
  phone: "(203) 561-5295",
};

assert(
  Object.keys(validateAttendee(valid)).length === 0,
  "well-formed attendee passes",
);

// name
assert(!!validateAttendee({ ...valid, name: "" }).name, "empty name rejected");
assert(!!validateAttendee({ ...valid, name: "   " }).name, "whitespace name rejected");
assert(!!validateAttendee({ name: undefined, email: valid.email, phone: valid.phone }).name, "missing name rejected");

// email
assert(!!validateAttendee({ ...valid, email: "" }).email, "empty email rejected");
assert(!!validateAttendee({ ...valid, email: "dana" }).email, "no-domain email rejected");
assert(!!validateAttendee({ ...valid, email: "dana@example" }).email, "no-TLD email rejected");
assert(!!validateAttendee({ ...valid, email: "dana @example.com" }).email, "email with spaces rejected");
assert(
  Object.keys(validateAttendee({ ...valid, email: "  dana@example.com  " })).length === 0,
  "email is trimmed before checking",
);

// phone
assert(!!validateAttendee({ ...valid, phone: "" }).phone, "empty phone rejected");
assert(!!validateAttendee({ ...valid, phone: "12345" }).phone, "too-short phone rejected");
assert(!!validateAttendee({ ...valid, phone: "1".repeat(16) }).phone, "too-long phone rejected");
assert(
  Object.keys(validateAttendee({ ...valid, phone: "+1 203 561 5295" })).length === 0,
  "E.164-ish phone with punctuation passes",
);
assert(
  Object.keys(validateAttendee({ ...valid, phone: "2035615295" })).length === 0,
  "bare 10-digit US phone passes",
);

// length caps (#1034): name/email/phone <= 200 chars so a caller can't store a
// multi-MB blob that flows into Postgres / gcal event bodies / webhook payloads.
assert(
  Object.keys(validateAttendee({ ...valid, name: "a".repeat(200) })).length === 0,
  "200-char name accepted (at the cap)",
);
assert(!!validateAttendee({ ...valid, name: "a".repeat(201) }).name, "over-200-char name rejected");
assert(
  !!validateAttendee({ ...valid, email: "a".repeat(200) + "@example.com" }).email,
  "over-200-char email rejected (even with a valid shape)",
);
// A phone with <=15 digits but a huge raw string (padding) passes the digit
// check yet must be rejected by the length cap.
assert(
  !!validateAttendee({ ...valid, phone: "1234567890" + "-".repeat(200) }).phone,
  "over-200-char phone rejected (10 digits but huge raw string)",
);

// multiple errors at once
const all = validateAttendee({ name: "", email: "nope", phone: "1" });
assert(
  !!all.name && !!all.email && !!all.phone,
  "reports every invalid field, not just the first",
);

/** The phone error for a candidate number, with the other fields valid. */
function phoneError(phone: string): string | undefined {
  return validateAttendee({ name: "Dana", email: "d@e.com", phone }).phone;
}

// --- US only, in ONE place (#1356) -------------------------------------------
// Dan's decision: Pennie can only CALL a US number. The field already capped at
// ten digits while this accepted 10 to 15, so a longer international number was
// refused by the field and accepted by the server, and the product said two
// different things about the same number. The validator now asks the same
// question the field does.
{
  eq(phoneError("(215) 555-0100"), undefined, "a formatted US number is accepted");
  eq(phoneError("2155550100"), undefined, "a bare ten digit number is accepted");
  eq(phoneError("+1 215 555 0100"), undefined, "and one carrying the US country code");

  // The case this issue exists for. It used to book successfully.
  const intl = phoneError("+44 20 7946 0958");
  assert(intl !== undefined, "an international number is refused");
  assert(
    /US/.test(intl ?? ""),
    `and the message says WHY, naming the rule rather than calling it invalid (got: ${intl})`,
  );

  // Distinct causes, distinct messages (L11). Somebody who typed eight digits has
  // an incomplete number, not a foreign one, and telling them about US numbers
  // would send them looking for a problem they do not have.
  const short = phoneError("21555");
  assert(short !== undefined, "a number too short is still refused");
  assert(
    !/US/.test(short ?? ""),
    `and is NOT told about country codes: it is an incomplete number (got: ${short})`,
  );
  assert(short !== intl, "the two causes do not share a message");

  eq(phoneError(""), "Enter your phone number", "an empty field keeps its own message");
}

finish();

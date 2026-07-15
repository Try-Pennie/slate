// Sanity test for the shared attendee contact validation (#37).
// Run: node --experimental-strip-types scripts/test-attendee.ts
import { validateAttendee } from "../src/lib/attendee.ts";
import { assert, finish } from "./lib/harness.ts";

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

// multiple errors at once
const all = validateAttendee({ name: "", email: "nope", phone: "1" });
assert(
  !!all.name && !!all.email && !!all.phone,
  "reports every invalid field, not just the first",
);

finish();

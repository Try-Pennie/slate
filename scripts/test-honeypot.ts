// Sanity test for the public-booker honeypot helper (#1033). A hidden decoy
// field on the Booker form that a real user never sees or fills; any submission
// that carries a value in it is a scripted bot. Pure; node-native.
// Run: node --experimental-strip-types scripts/test-honeypot.ts
import { HONEYPOT_FIELD, honeypotTripped } from "../src/lib/booking/honeypot.ts";
import { assert, finish } from "./lib/harness.ts";

// The field name is the single source of truth shared by the client form and the
// server route, so the two can never drift apart.
assert(typeof HONEYPOT_FIELD === "string" && HONEYPOT_FIELD.length > 0, "honeypot field name is a non-empty string");

// A real submission leaves the decoy empty / absent.
assert(honeypotTripped(undefined) === false, "absent value does not trip");
assert(honeypotTripped(null) === false, "null value does not trip");
assert(honeypotTripped("") === false, "empty string does not trip");
assert(honeypotTripped("   ") === false, "whitespace-only value does not trip (real autofill blanks)");

// A bot that fills every field trips it.
assert(honeypotTripped("https://spam.example") === true, "a filled value trips");
assert(honeypotTripped("  x  ") === true, "a value with surrounding whitespace still trips");

// Non-string junk a bot might send is treated as tripped only when it carries content.
assert(honeypotTripped(123 as unknown) === true, "a non-empty non-string value trips");

finish();

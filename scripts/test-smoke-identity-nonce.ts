// #3581: smoke booking identities must be unique per run, and no scenario may
// hand-roll a FIXED plus-alias (which reintroduces the cancelled-tombstone chain the
// reschedule smoke hit, #3576). Tests the shared helper's uniqueness and scans the
// live smoke scripts for a hand-rolled fixed identity literal.
//
// Run: node --experimental-strip-types scripts/test-smoke-identity-nonce.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { smokeAttendee } from "./lib/smoke-identity.ts";

// Unique per run.
const a = smokeAttendee("main", 1000);
const b = smokeAttendee("main", 2000);
assert(a.email !== b.email && a.externalId !== b.externalId, "different nonce -> different identity");
eq(smokeAttendee("main", 1000).email, a.email, "same nonce -> same email (stable within a run)");
assert(a.email.startsWith("smoketest+main-") && a.email.endsWith("@trypennie.com"), "email is a smoketest plus-alias");
// An injected nonce flows through verbatim.
eq(smokeAttendee("x", 42).externalId, "smoke-x-42", "nonce flows into the external id");
// The DEFAULT nonce combines Date.now() with a per-process counter, so two no-nonce
// calls differ even within the same millisecond (exercises the counter, no sleep: if
// the counter were removed these could collide, and this assertion would catch it).
assert(smokeAttendee("main").email !== smokeAttendee("main").email, "default nonce is unique per call");

// Scan the live smoke scripts: each must (a) go through the shared identity helper, and
// (b) carry no hand-rolled plus-alias built inline. A fixed literal and an inline
// template (`smoketest+${...}@`) are both caught; only the helper call is allowed.
const ROOT = join(import.meta.dirname, "..");
// A `smoketest+...@trypennie.com` alias written inline as a quoted/backticked string,
// in ANY form (letters, digits, underscores, an interpolation) rather than only the
// spellings the author first thought of (L273). A `//` comment mentioning the mailbox
// is not a quoted string, so it is not caught.
const INLINE_ALIAS = /[`"']smoketest\+[^`"']*@trypennie\.com/;
const booking = readFileSync(join(ROOT, "scripts", "smoke-booking-api.ts"), "utf8");
const resched = readFileSync(join(ROOT, "scripts", "smoke-reschedule.ts"), "utf8");
// The helper is actually wired, so the guard is not vacuous: the scripts import it.
assert(/from "\.\/lib\/smoke-identity\.ts"/.test(booking), "smoke-booking-api imports the smokeAttendee helper");
assert(/from "\.\/lib\/smoke-reschedule-identity\.ts"/.test(resched), "smoke-reschedule imports the rescheduleSmokeIdentity helper");
// And neither builds a plus-alias inline (the helper is the only place one is formed).
assert(!INLINE_ALIAS.test(booking), "smoke-booking-api builds no inline smoketest+ alias (uses smokeAttendee)");
assert(!INLINE_ALIAS.test(resched), "smoke-reschedule builds no inline smoketest+ alias (uses rescheduleSmokeIdentity)");
// Positive control: the scan catches every alias form (not a no-op, L1), including the
// digit/underscore spellings a narrower pattern would have missed.
assert(INLINE_ALIAS.test('email: "smoketest+foo@trypennie.com"'), "scan catches a fixed-literal alias");
assert(INLINE_ALIAS.test("email: `smoketest+${tag}-${n}@trypennie.com`"), "scan catches an inline template alias");
assert(INLINE_ALIAS.test('"smoketest+1@trypennie.com"'), "scan catches a digit-form alias");
assert(INLINE_ALIAS.test('"smoketest+_x@trypennie.com"'), "scan catches an underscore-form alias");

finish();

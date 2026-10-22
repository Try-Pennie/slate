// #3581: smoke booking identities must be unique per run, and no scenario may
// hand-roll a FIXED plus-alias (which reintroduces the cancelled-tombstone chain the
// reschedule smoke hit, #3576). Tests the shared helper's uniqueness and scans the
// live smoke scripts for a hand-rolled fixed identity literal.
//
// #4060: the PHONE is part of the identity too. Person dedupe treats a phone match
// alone as a weak match, so a fixed phone let a booking one crashed run left active
// turn the next run's create into `409 confirm_required` carrying the OLD booking
// (2026-10-21, runs 39694932888 and 39698605820). Every smoke script must take its
// phone from the shared helper, and the scan below fails on a phone written inline.
//
// Run: node --experimental-strip-types scripts/test-smoke-identity-nonce.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { smokeAttendee, smokePhone } from "./lib/smoke-identity.ts";
import { rescheduleSmokeIdentity } from "./lib/smoke-reschedule-identity.ts";

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
// #4060: the reschedule run moved into a testable module the script calls.
const reschedRun = readFileSync(join(ROOT, "scripts", "lib", "smoke-reschedule-run.ts"), "utf8");
// The helper is actually wired, so the guard is not vacuous: the scripts import it.
assert(/from "\.\/lib\/smoke-identity\.ts"/.test(booking), "smoke-booking-api imports the smokeAttendee helper");
assert(/from "\.\/lib\/smoke-reschedule-run\.ts"/.test(resched), "smoke-reschedule runs the shared reschedule run");
assert(
  /from "\.\/smoke-reschedule-identity\.ts"/.test(reschedRun),
  "the reschedule run imports the rescheduleSmokeIdentity helper",
);
// And neither builds a plus-alias inline (the helper is the only place one is formed).
assert(!INLINE_ALIAS.test(booking), "smoke-booking-api builds no inline smoketest+ alias (uses smokeAttendee)");
assert(!INLINE_ALIAS.test(resched), "smoke-reschedule builds no inline smoketest+ alias (uses rescheduleSmokeIdentity)");
// Positive control: the scan catches every alias form (not a no-op, L1), including the
// digit/underscore spellings a narrower pattern would have missed.
assert(INLINE_ALIAS.test('email: "smoketest+foo@trypennie.com"'), "scan catches a fixed-literal alias");
assert(INLINE_ALIAS.test("email: `smoketest+${tag}-${n}@trypennie.com`"), "scan catches an inline template alias");
assert(INLINE_ALIAS.test('"smoketest+1@trypennie.com"'), "scan catches a digit-form alias");
assert(INLINE_ALIAS.test('"smoketest+_x@trypennie.com"'), "scan catches an underscore-form alias");

// --- #4060: the phone is unique per identity, and no smoke script writes one inline ---

// A well formed US number in E.164, so the booking API's US only check accepts it.
const E164_US = /^\+1\d{10}$/;
assert(E164_US.test(a.phone), `smokeAttendee returns an E.164 US phone (${a.phone})`);
// Unique per CALL within a process, guaranteed rather than probable: two scenarios in
// one run must never share a phone, or the second weak matches the first.
const phones = new Set(Array.from({ length: 50 }, () => smokeAttendee("main").phone));
eq(phones.size, 50, "50 smokeAttendee calls in one process -> 50 distinct phones");
// The shared builder: the line number comes from the serial, the area code is kept.
eq(smokePhone(1234, "202"), "+12025551234", "smokePhone keeps the area code and uses the last 4 digits");
eq(smokePhone(20_000_007, "215"), "+12155550007", "smokePhone pads the line number to 4 digits");
// The reschedule smoke's phone comes from its run nonce, so it is stable within the
// run and different across runs, like its email.
eq(
  rescheduleSmokeIdentity("s", 1000).phone,
  rescheduleSmokeIdentity("s", 1000).phone,
  "reschedule phone is stable within a run",
);
assert(
  rescheduleSmokeIdentity("s", 1000).phone !== rescheduleSmokeIdentity("s", 2001).phone,
  "reschedule phone differs across runs",
);
assert(E164_US.test(rescheduleSmokeIdentity("s", 1000).phone), "reschedule phone is an E.164 US phone");
// The two families never share a number: the reschedule smoke and the booking canary
// run in the same workflow, so their phones live in different area codes.
assert(
  rescheduleSmokeIdentity("s", 1000).phone.slice(0, 5) !== a.phone.slice(0, 5),
  "reschedule and booking canary phones use different area codes",
);

// A phone written inline as a quoted or backticked string: "+1" followed by a digit or
// an interpolation, or a bare ten digit number. Scanned over EVERY smoke script, not a
// list of the ones that book today (L96), so a new scenario is covered by construction.
const INLINE_PHONE = /[`"']\+1(\d|\$\{)|[`"']\d{10}[`"']/;
// The smoke modules under scripts/lib are scanned too (the reschedule run lives
// there), all but the two identity helpers, which are the one place a phone and an
// alias are allowed to be built.
const IDENTITY_HELPERS = new Set(["lib/smoke-identity.ts", "lib/smoke-reschedule-identity.ts"]);
const smokeScripts = [
  ...readdirSync(join(ROOT, "scripts")).filter((f) => /^smoke-.*\.ts$/.test(f)),
  ...readdirSync(join(ROOT, "scripts", "lib"))
    .filter((f) => /^smoke-.*\.ts$/.test(f))
    .map((f) => `lib/${f}`)
    .filter((f) => !IDENTITY_HELPERS.has(f)),
].sort();
assert(smokeScripts.length >= 5, `the scan sees the smoke scripts (${smokeScripts.length} found)`);
assert(smokeScripts.includes("lib/smoke-reschedule-run.ts"), "the scan includes the reschedule run module");
for (const f of smokeScripts) {
  const src = readFileSync(join(ROOT, "scripts", f), "utf8");
  const hit = src.split("\n").findIndex((line) => !/^\s*\/\//.test(line) && INLINE_PHONE.test(line));
  assert(
    hit === -1,
    `${f} writes no phone inline (take it from smokeAttendee or rescheduleSmokeIdentity)${hit === -1 ? "" : `: line ${hit + 1}`}`,
  );
  // A plus-alias written inline is the same fault for the email, in every script.
  assert(!INLINE_ALIAS.test(src), `${f} builds no inline smoketest+ alias`);
  // The other half of #4060: a script that takes a manage token from a create must
  // first refuse an answer that is not its own new booking, and must tear down
  // through the retrying cancel, both from scripts/lib/smoke-own-booking.ts.
  if (/\btokenFrom\(/.test(src) && f !== "smoke-lib.ts") {
    assert(/\bcreateRefusal\(/.test(src), `${f} refuses a create that is not 200 created before taking its token`);
    assert(
      /\bcancelSmokeBooking\(/.test(src) && !/\/cancel`,\s*\{\s*reason/.test(src),
      `${f} cancels through cancelSmokeBooking, not a one shot post`,
    );
  }
}
// Positive controls (L1): each spelling the incident and the old code used.
assert(INLINE_PHONE.test('phone: "+12025550123"'), "scan catches the fixed reschedule phone");
assert(INLINE_PHONE.test('const phone = "+12155550100";'), "scan catches a fixed canary phone");
assert(INLINE_PHONE.test("const phone = `+1215555${String(Date.now()).slice(-4)}`;"), "scan catches an inline built phone");
assert(INLINE_PHONE.test("const phone = `+1${area}5550100`;"), "scan catches an interpolated area code");
assert(INLINE_PHONE.test('phone: "2155550100"'), "scan catches a bare ten digit phone");
// Control for the one shot cancel pattern, in the exact spelling the scripts used.
assert(
  /\/cancel`,\s*\{\s*reason/.test('await jpost(`/api/bookings/${token}/cancel`, { reason: "no_longer_interested" });'),
  "scan catches a one shot teardown cancel",
);
// Negative controls: the shapes that legitimately appear in these scripts.
assert(!INLINE_PHONE.test('start: "2026-10-12T12:00:00.000Z"'), "scan ignores an ISO timestamp");
assert(!INLINE_PHONE.test("phone: id.phone"), "scan ignores a phone taken from the helper");

finish();

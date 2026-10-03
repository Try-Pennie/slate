// Security header policy for authenticated staff surfaces (#592). The middleware
// applies these to /admin, /me, /login, never to /book or widget.js, so the embed
// stays frameable per the slate-embed-contract. This locks the policy values; the
// middleware wiring is exercised by src/middleware.test.ts.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-security-headers.ts
import { SECURITY_HEADERS } from "@/lib/security-headers";
import { buildContentSecurityPolicy } from "@/lib/csp";
import { assert, finish } from "./lib/harness.ts";

// Clickjacking defense, legacy half: X-Frame-Options.
assert(
  SECURITY_HEADERS["X-Frame-Options"] === "DENY",
  "X-Frame-Options DENY (legacy browsers)",
);

// Clickjacking defense, modern half: since #2575 it is a directive of the one
// ENFORCED policy rather than a second Content-Security-Policy header. Two values
// of that header cannot both be the one Next reads its nonce from, and the framing
// only one won the read and carried no nonce, so the staff pages got none.
assert(
  SECURITY_HEADERS["Content-Security-Policy"] === undefined,
  "no separate framing only CSP in the staff bundle (it would shadow the nonce carrying policy)",
);
const staffPolicy = buildContentSecurityPolicy({ nonce: "n", frameable: false });
assert(
  staffPolicy.split(";").map((d) => d.trim()).includes("frame-ancestors 'none'"),
  "the staff policy denies every frame ancestor (blocks clickjacking of staff pages)",
);
assert(
  !buildContentSecurityPolicy({ nonce: "n", frameable: true }).includes("frame-ancestors"),
  "CONTROL: the booker's policy says nothing about framing, so the embed keeps working",
);

// Baseline hardening (nosniff, Referrer-Policy) and HSTS are NOT in this
// staff-only bundle: they don't restrict framing, so they are served on EVERY
// response via next.config `headers()` (HSTS #1024; nosniff + Referrer-Policy
// #1030, so the PII-bearing booker / manage-by-token / /api responses carry them
// too). All three are covered by test-global-headers.ts. Locking their absence
// here keeps this bundle to the framing-only headers and prevents a duplicate
// header creeping back onto /admin, /me, /login.
assert(
  SECURITY_HEADERS["X-Content-Type-Options"] === undefined,
  "nosniff is not in the staff bundle (served globally via next.config, no duplicate)",
);
assert(
  SECURITY_HEADERS["Referrer-Policy"] === undefined,
  "Referrer-Policy is not in the staff bundle (served globally via next.config)",
);
assert(
  SECURITY_HEADERS["Strict-Transport-Security"] === undefined,
  "HSTS is not in the staff bundle (served globally via next.config, no duplicate)",
);

finish();

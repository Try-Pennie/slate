// Security header policy for authenticated staff surfaces (#592). The middleware
// applies these to /admin, /me, /login (its matcher), never to /book or
// widget.js, so the embed stays frameable per the slate-embed-contract. This
// locks the policy values; the middleware wiring is exercised in the app.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-security-headers.ts
import { SECURITY_HEADERS } from "@/lib/security-headers";
import { assert, finish } from "./lib/harness.ts";

// Clickjacking defense: modern (CSP) + legacy (X-Frame-Options) both present.
assert(
  SECURITY_HEADERS["Content-Security-Policy"] === "frame-ancestors 'none'",
  "CSP denies all frame ancestors (blocks clickjacking of staff pages)",
);
assert(
  SECURITY_HEADERS["X-Frame-Options"] === "DENY",
  "X-Frame-Options DENY (legacy browsers)",
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

// The policy must NOT itself carry a content CSP that could break app scripts;
// only frame-ancestors is set (the script policy is served report only from
// `src/lib/csp.ts`, #2565; enforcing it is #2575).
assert(
  !/script-src|default-src/.test(SECURITY_HEADERS["Content-Security-Policy"] ?? ""),
  "CSP is frame-ancestors only (no script/default-src that could break the app)",
);

finish();

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

// Baseline hardening.
assert(
  SECURITY_HEADERS["X-Content-Type-Options"] === "nosniff",
  "nosniff (no MIME sniffing)",
);
assert(
  SECURITY_HEADERS["Referrer-Policy"] === "strict-origin-when-cross-origin",
  "a privacy-preserving Referrer-Policy",
);

// HSTS is deliberately NOT in this staff-only bundle: it is transport-only, so
// it is served on EVERY response via next.config `headers()` (#1024, covered by
// test-hsts-global.ts). Locking its absence here prevents a duplicate
// `Strict-Transport-Security` header creeping back onto /admin, /me, /login.
assert(
  SECURITY_HEADERS["Strict-Transport-Security"] === undefined,
  "HSTS is not in the staff bundle (served globally via next.config, no duplicate)",
);

// The policy must NOT itself carry a content CSP that could break app scripts;
// only frame-ancestors is set (a full content-CSP is a separate effort).
assert(
  !/script-src|default-src/.test(SECURITY_HEADERS["Content-Security-Policy"] ?? ""),
  "CSP is frame-ancestors only (no script/default-src that could break the app)",
);

finish();

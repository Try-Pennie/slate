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

// HSTS: HTTPS-only origin (Cloudflare). Long max-age, no preload (reversible).
const hsts = SECURITY_HEADERS["Strict-Transport-Security"] ?? "";
assert(/max-age=\d{7,}/.test(hsts), "HSTS has a long max-age");
assert(/includeSubDomains/.test(hsts), "HSTS includes subdomains");
assert(!/preload/.test(hsts), "HSTS does NOT preload (kept reversible)");

// The policy must NOT itself carry a content CSP that could break app scripts;
// only frame-ancestors is set (a full content-CSP is a separate effort).
assert(
  !/script-src|default-src/.test(SECURITY_HEADERS["Content-Security-Policy"] ?? ""),
  "CSP is frame-ancestors only (no script/default-src that could break the app)",
);

finish();

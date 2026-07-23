// Global HSTS coverage (#1024). The 2026-07-23 production-readiness audit found
// the public booker (name / email / phone) reachable over plain http, and HSTS
// was served only on the staff surfaces (/admin, /me, /login) via the middleware
// matcher. HSTS is transport-only and does NOT restrict framing, so it is safe
// to serve on every response, including the embeddable booker. This guard asserts
// two things about next.config's global headers():
//   1. Strict-Transport-Security with a long max-age is served on ALL paths, so a
//      returning visitor's browser auto-upgrades http->https before sending PII.
//   2. The global rule does NOT carry framing headers (X-Frame-Options /
//      frame-ancestors), which would break the embed contract if applied site-wide.
// (The first-visit http->https redirect is a Cloudflare zone setting, out of code.)
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-hsts-global.ts
import nextConfig from "../next.config.ts";
import { assert, finish } from "./lib/harness.ts";

const rules = typeof nextConfig.headers === "function" ? await nextConfig.headers() : [];

// A source matches "all paths" when it is the catch-all Next patterns.
const ALL_PATHS = new Set(["/:path*", "/(.*)", "/:path*/", "/((?!_next).*)"]);
const isAllPaths = (source: string) => ALL_PATHS.has(source) || /:path\*/.test(source);

const globalRules = rules.filter((r) => isAllPaths(r.source));
assert(globalRules.length > 0, "next.config headers() has a catch-all rule covering every path");

const globalHeaders = globalRules.flatMap((r) => r.headers);
const hsts = globalHeaders.find((h) => h.key.toLowerCase() === "strict-transport-security");
assert(hsts !== undefined, "Strict-Transport-Security is served on all paths");
if (hsts) {
  const m = hsts.value.match(/max-age=(\d+)/);
  const maxAge = m ? Number(m[1]) : 0;
  // A year or more; a short max-age offers little protection.
  assert(maxAge >= 31536000, `HSTS max-age is >= 1 year (got ${maxAge})`);
}

// Framing headers must NOT be applied globally (they stay middleware-only on the
// staff routes) or the booker stops being embeddable on partner pages.
const framing = globalHeaders.filter((h) => {
  const k = h.key.toLowerCase();
  return k === "x-frame-options" || (k === "content-security-policy" && /frame-ancestors/.test(h.value));
});
assert(framing.length === 0, "global headers() does NOT set framing headers (embed stays frameable)");

finish();

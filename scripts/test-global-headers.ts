// Global response-hardening headers (#1024 HSTS, #1030 nosniff + Referrer-Policy).
// The 2026-07-23 production-readiness audit found the PII-bearing public booker
// (name / email / phone), the manage-by-token pages, and all /api responses
// carried none of the standard hardening headers: those were served only on the
// staff surfaces (/admin, /me, /login) via the middleware matcher. None of these
// three restrict framing, so they are safe to serve on every response including
// the embeddable booker. This guard asserts three things about next.config's
// global headers():
//   1. Strict-Transport-Security with a long max-age is served on ALL paths, so a
//      returning visitor's browser auto-upgrades http->https before sending PII.
//   2. X-Content-Type-Options: nosniff and a privacy-preserving Referrer-Policy
//      are served on ALL paths (#1030), so the booker / manage / api carry them.
//   3. The global rule does NOT carry framing headers (X-Frame-Options /
//      frame-ancestors), which would break the embed contract if applied site-wide.
// (The first-visit http->https redirect is a Cloudflare zone setting, out of code.)
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-global-headers.ts
import nextConfig from "../next.config.ts";
import { readFileSync } from "node:fs";
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

// #1030: nosniff + a privacy-preserving Referrer-Policy on every response, so the
// booker / manage-by-token / api surfaces get the baseline hardening the staff
// bundle already had.
const nosniff = globalHeaders.find((h) => h.key.toLowerCase() === "x-content-type-options");
assert(nosniff?.value === "nosniff", "X-Content-Type-Options: nosniff is served on all paths (#1030)");
const referrer = globalHeaders.find((h) => h.key.toLowerCase() === "referrer-policy");
assert(
  referrer?.value === "strict-origin-when-cross-origin",
  "a privacy-preserving Referrer-Policy is served on all paths (#1030)",
);

// Framing headers must NOT be applied globally (they stay middleware-only on the
// staff routes) or the booker stops being embeddable on partner pages.
const framing = globalHeaders.filter((h) => {
  const k = h.key.toLowerCase();
  return k === "x-frame-options" || (k === "content-security-policy" && /frame-ancestors/.test(h.value));
});
assert(framing.length === 0, "global headers() does NOT set framing headers (embed stays frameable)");

// #1756: nothing Slate serves belongs in a search index. It is an internal booking
// tool plus an embeddable widget, and the public booker at /book?xbc=<code> can
// create a REAL booking against a real agent, so a crawler surfacing it is a
// discovery path nobody chose. Measured 2026-09-13: production answered 200 on
// /book?xbc=111 with no X-Robots-Tag and no noindex in the markup, and the
// robots.txt the domain serves (Cloudflare's injected content-signals file, since
// this repo ships none) carries no Disallow at all.
//
// It is set GLOBALLY rather than on /book alone, deliberately. The manage by token
// pages, every /api response and the staff surfaces are all equally things that
// should never appear in a search result, and a per path rule is one somebody has
// to remember to extend when a route is added (L96).
const robots = globalHeaders.find((h) => h.key.toLowerCase() === "x-robots-tag");
assert(robots !== undefined, "X-Robots-Tag is served on all paths (#1756)");
if (robots) {
  assert(/\bnoindex\b/.test(robots.value), "and it says noindex, so nothing is indexed");
  assert(
    /\bnofollow\b/.test(robots.value),
    "and nofollow, so a crawler that does reach one page is not led into other bucket codes",
  );
}

// THE TRAP, asserted because the two halves work against each other. A `Disallow`
// in robots.txt stops a crawler FETCHING the page, which means it never sees the
// noindex header above and the URL can still be indexed from a link elsewhere. So
// the correct pairing for "keep this out of search" is to ALLOW crawling and send
// noindex, and a Disallow added later would silently disable the header this guard
// exists to protect. This repo ships no robots file today; if one is added, it must
// not disallow the surfaces the header covers.
{
  const candidates = ["public/robots.txt", "src/app/robots.ts", "src/app/robots.txt"];
  for (const rel of candidates) {
    let body = "";
    try {
      body = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    } catch {
      continue; // not shipped, nothing to check
    }
    const disallowsBooker = /Disallow:\s*\/(\s|$|book)/i.test(body) || /disallow:\s*\[?\s*["']\/(\s|["']|book)/i.test(body);
    assert(
      !disallowsBooker,
      `${rel} must not Disallow the booker, or the X-Robots-Tag noindex above is never fetched and never applied (#1756)`,
    );
  }
}

finish();

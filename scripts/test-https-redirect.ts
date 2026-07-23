// Unit test for the http->https redirect guard (#1024). The live assertion runs
// in the smoke canary (scripts/smoke-booking-api.ts); the pure logic it depends
// on lives in scripts/lib/https-redirect.ts and is tested here.
import { assert, finish } from "./lib/harness.ts";
import { httpProbeUrl, isHttpsRedirect } from "./lib/https-redirect.ts";

// --- httpProbeUrl: derive the http:// URL to probe, or null to skip ---
assert(httpProbeUrl("https://slate.trypennie.app") === "http://slate.trypennie.app/", "https prod base -> http probe url");
assert(httpProbeUrl("https://slate.trypennie.app/") === "http://slate.trypennie.app/", "trailing slash on base is normalized");
assert(httpProbeUrl("http://localhost:3000") === null, "http localhost dev base -> skip (null)");
assert(httpProbeUrl("https://localhost:3000") === null, "https localhost dev base -> skip (null)");
assert(httpProbeUrl("https://127.0.0.1:3000") === null, "https loopback IP -> skip (null)");
assert(httpProbeUrl("http://slate.trypennie.app") === null, "already-http base -> skip (null)");
assert(httpProbeUrl("not a url") === null, "unparseable base -> null");

// --- isHttpsRedirect: is an http:// response a compliant https redirect? ---
assert(isHttpsRedirect(301, "https://slate.trypennie.app/") === true, "301 -> https:// is compliant");
assert(isHttpsRedirect(308, "https://slate.trypennie.app/book") === true, "308 -> https:// is compliant");
assert(isHttpsRedirect(302, "https://x/") === true, "302 -> https:// is compliant");
assert(isHttpsRedirect(307, "https://x/") === true, "307 -> https:// is compliant");
// The audited gap: 200 over plaintext with no redirect (#1024).
assert(isHttpsRedirect(200, null) === false, "200 with no Location (the audited plaintext gap) is NOT compliant");
assert(isHttpsRedirect(301, "http://slate.trypennie.app/") === false, "301 that lands on http:// is NOT compliant");
assert(isHttpsRedirect(301, null) === false, "301 with no Location is NOT compliant");
assert(isHttpsRedirect(200, "https://x/") === false, "200 is NOT a redirect even with an https Location");

finish();

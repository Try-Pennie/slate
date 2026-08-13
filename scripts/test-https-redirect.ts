// Unit test for the http->https redirect guard (#1024). The live assertion runs
// in the smoke canary (scripts/smoke-booking-api.ts); the pure logic it depends
// on lives in scripts/lib/https-redirect.ts and is tested here.
import { assert, finish } from "./lib/harness.ts";
import {
  assetProbeUrl,
  evaluateStaticAssetTransport,
  httpProbeUrl,
  isHttpsRedirect,
  missingSecurityHeaders,
  redirectVerdict,
  transportVerdict,
} from "./lib/https-redirect.ts";

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

// --- redirectVerdict: warn until the redirect is expected, then page ---
// A page-able failure BEFORE the redirect is live in production is
// self-inflicted alert noise, so the guard only pages once we EXPECT the
// redirect (EXPECT_HTTPS_REDIRECT=1, set once it is confirmed live).
assert(redirectVerdict(true, true) === "ok", "redirect present + expected -> ok");
assert(redirectVerdict(true, false) === "ok", "redirect present + not yet expected -> ok (already live)");
assert(redirectVerdict(false, true) === "page", "redirect absent + expected -> page (regression)");
assert(redirectVerdict(false, false) === "warn", "redirect absent + not yet expected -> warn (redirect not live yet, no page)");

// --- transportVerdict: the same warn-then-page tiering, for any transport check ---
// redirectVerdict is now one caller of this; the static-asset header check is the
// other, so both tier alerts the same way instead of each inventing its own.
assert(transportVerdict(true, true) === "ok", "compliant + expected -> ok");
assert(transportVerdict(false, true) === "page", "non-compliant + expected -> page");
assert(transportVerdict(false, false) === "warn", "non-compliant + not yet expected -> warn");

// --- assetProbeUrl: point a probe at a file under public/ ---
// #1203/#1204: the assets under public/ are served by Cloudflare's asset binding
// without invoking the Worker, so they were the one surface the #1024 redirect
// and the global headers never reached. The probe has to hit the ASSET path, not
// the site root, or it just re-tests what /api/health already covers.
assert(
  assetProbeUrl("https://slate.trypennie.app", "/widget.js") === "http://slate.trypennie.app/widget.js",
  "https prod base + asset path -> http probe url for that asset",
);
assert(
  assetProbeUrl("https://slate.trypennie.app/", "/widget.js") === "http://slate.trypennie.app/widget.js",
  "trailing slash on the base does not double up",
);
assert(
  assetProbeUrl("http://localhost:3000", "/widget.js") === null,
  "localhost dev base -> skip (null), same as httpProbeUrl",
);

// --- missingSecurityHeaders: which hardening headers a response is missing ---
// The measured #1204 gap: widget.js carried NONE of the three that every page
// and API route carries.
const bare = () => null;
assert(
  missingSecurityHeaders(bare).length === 3,
  "a response with no hardening headers reports all three missing (the measured widget.js gap)",
);
const full = (name: string) =>
  ({
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  })[name.toLowerCase()] ?? null;
assert(
  missingSecurityHeaders(full).length === 0,
  "a fully hardened response reports nothing missing",
);
// Partial coverage must not read as compliant: the nosniff header is the one
// that matters most on a script, so a response carrying only the other two is
// still a finding, named specifically rather than as a bare count.
const noNosniff = (name: string) =>
  name.toLowerCase() === "x-content-type-options" ? null : full(name);
assert(
  missingSecurityHeaders(noNosniff).join() === "x-content-type-options",
  "a response missing only nosniff names exactly that header",
);
// An empty header value is not a header. A blank Referrer-Policy tells a browser
// nothing, so counting it as present would report a gap as covered.
const blankReferrer = (name: string) =>
  name.toLowerCase() === "referrer-policy" ? "" : full(name);
assert(
  missingSecurityHeaders(blankReferrer).join() === "referrer-policy",
  "a present-but-empty header counts as missing",
);

// --- evaluateStaticAssetTransport: the live asset probe, off the network ---
// The decision the smoke canary renders for #1203/#1204. `fetch` is injected so
// every branch (including the ones that only happen when production is broken)
// is provable without a network, and so a test can never hit the real site (L2).
{
  const hardened = {
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  /** A fake origin: `plain` answers the http probe, `secure` answers the https GET. */
  function fakeFetch(plain: { status: number; location?: string }, secure: { status: number; contentType?: string; headers?: Record<string, string> } | Error) {
    return async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.startsWith("http://")) {
        return new Response(null, {
          status: plain.status,
          headers: plain.location ? { location: plain.location } : {},
        });
      }
      if (secure instanceof Error) throw secure;
      return new Response("(function(){})()", {
        status: secure.status,
        headers: { "content-type": secure.contentType ?? "text/javascript", ...(secure.headers ?? {}) },
      });
    };
  }
  const levels = (checks: { level: string }[]) => checks.map((c) => c.level).join(",");
  const text = (checks: { message: string }[]) => checks.map((c) => c.message).join(" | ");

  const compliant = await evaluateStaticAssetTransport({
    base: "https://slate.trypennie.app",
    expected: true,
    fetchImpl: fakeFetch(
      { status: 308, location: "https://slate.trypennie.app/widget.js" },
      { status: 200, headers: hardened },
    ),
  });
  assert(levels(compliant) === "ok,ok,ok", "a fully fixed asset reports ok for redirect, serving and headers");

  // The measured #1203/#1204 state: 200 over plaintext, no headers.
  const audited = await evaluateStaticAssetTransport({
    base: "https://slate.trypennie.app",
    expected: true,
    fetchImpl: fakeFetch({ status: 200 }, { status: 200 }),
  });
  assert(levels(audited) === "fail,ok,fail", "the audited state fails the redirect and header checks, but the file still serves");
  assert(/strict-transport-security/.test(text(audited)), "the header failure NAMES what is missing rather than just failing");

  // Before the fix is armed, the same state must WARN, never page.
  const notYetArmed = await evaluateStaticAssetTransport({
    base: "https://slate.trypennie.app",
    expected: false,
    fetchImpl: fakeFetch({ status: 200 }, { status: 200 }),
  });
  assert(levels(notYetArmed) === "warn,ok,warn", "unarmed, the same broken state warns instead of paging");

  // FAILURE PATH: the asset route itself breaks. Routing assets through the
  // Worker makes this the plausible regression, and it is worse than a missing
  // header: every partner embed breaks at once. An HTML 404 must NOT read as ok.
  const broken = await evaluateStaticAssetTransport({
    base: "https://slate.trypennie.app",
    expected: true,
    fetchImpl: fakeFetch(
      { status: 308, location: "https://slate.trypennie.app/widget.js" },
      { status: 404, contentType: "text/html; charset=utf-8", headers: hardened },
    ),
  });
  assert(levels(broken) === "ok,fail,ok", "a 404 HTML page in place of the script fails the serving check");

  // FAILURE PATH: the probe cannot reach the site at all. An unreachable asset
  // is the one thing that must never score as compliant, because "no answer"
  // and "healthy" would otherwise be the same result.
  const unreachable = await evaluateStaticAssetTransport({
    base: "https://slate.trypennie.app",
    expected: true,
    sleep: async () => {},
    fetchImpl: fakeFetch(
      { status: 308, location: "https://slate.trypennie.app/widget.js" },
      new Error("connection refused"),
    ),
  });
  assert(levels(unreachable) === "ok,fail,fail", "an unreachable asset fails serving AND headers, never silently passes");
  assert(
    /unreachable, connection refused/.test(text(unreachable)),
    "and says it could not be reached, so a reader is not left guessing at `got 0`",
  );

  // A local dev base has no https to assert, so the whole check SKIPs rather
  // than false-failing (matching httpProbeUrl).
  const local = await evaluateStaticAssetTransport({
    base: "http://localhost:3000",
    expected: true,
    fetchImpl: async () => {
      throw new Error("a skipped check must not fetch anything");
    },
  });
  assert(levels(local) === "skip", "a localhost base skips the whole check without fetching");
}

// --- #1210: one retry for an unreachable probe, and nothing else ----------
// The canary ticks every 30 minutes against the live site, so a single network
// blip used to page for an embed that was already fine. The retry is bounded and
// deliberately narrow: it only fires when there was NO answer, because a 404 or a
// missing header answered on the first look and a second look would say the same
// thing later. The counts are asserted, not just the verdicts, since a retry that
// silently fired on every probe would double the canary's requests while every
// verdict stayed identical.
{
  const hardened = {
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  const levels = (checks: { level: string }[]) => checks.map((c) => c.level).join(",");

  /**
   * A fake origin that counts calls per URL scheme and can be told to reject the
   * first N attempts at either probe.
   */
  function countingFetch(opts: { failPlain?: number; failSecure?: number; secureStatus?: number; secureType?: string }) {
    const calls = { plain: 0, secure: 0 };
    const impl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.startsWith("http://")) {
        calls.plain++;
        if (calls.plain <= (opts.failPlain ?? 0)) throw new Error("socket hang up");
        return new Response(null, {
          status: 308,
          headers: { location: "https://slate.trypennie.app/widget.js" },
        });
      }
      calls.secure++;
      if (calls.secure <= (opts.failSecure ?? 0)) throw new Error("socket hang up");
      return new Response("(function(){})()", {
        status: opts.secureStatus ?? 200,
        headers: { "content-type": opts.secureType ?? "text/javascript", ...hardened },
      });
    };
    return { calls, impl };
  }
  const run = (impl: typeof fetch) =>
    evaluateStaticAssetTransport({
      base: "https://slate.trypennie.app",
      expected: true,
      fetchImpl: impl,
      sleep: async () => {},
    });

  // A blip that clears on the retry leaves the run green.
  const blipSecure = countingFetch({ failSecure: 1 });
  const recovered = await run(blipSecure.impl);
  assert(levels(recovered) === "ok,ok,ok", "#1210: a blip on the https probe that clears on the retry leaves the run green");
  assert(blipSecure.calls.secure === 2, "the https probe really was attempted twice");
  assert(blipSecure.calls.plain === 1, "and the probe that answered first time was not retried");

  const blipPlain = countingFetch({ failPlain: 1 });
  const recoveredPlain = await run(blipPlain.impl);
  assert(levels(recoveredPlain) === "ok,ok,ok", "#1210: a blip on the plaintext probe also clears on the retry");
  assert(blipPlain.calls.plain === 2, "the plaintext probe was attempted twice");

  // FAILURE PATH: a genuinely dead embed script still pages, after the retry.
  const dead = countingFetch({ failSecure: 5 });
  const stillDead = await run(dead.impl);
  assert(levels(stillDead) === "ok,fail,fail", "#1210: a retry that also fails keeps today's hard failure, so a dead embed still pages");
  assert(dead.calls.secure === 2, "having looked exactly twice, not once and not forever");

  // A REACHABLE finding is not retried. This is the property that stops the retry
  // becoming a way to spend two round trips confirming the same 404.
  const four04 = countingFetch({ secureStatus: 404, secureType: "text/html" });
  const notFound = await run(four04.impl);
  assert(levels(notFound) === "ok,fail,ok", "a 404 in place of the script still fails on the first look");
  assert(four04.calls.secure === 1, "#1210: a response that arrived is never retried, whatever it said");
}

finish();

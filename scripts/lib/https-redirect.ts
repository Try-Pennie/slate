/**
 * Transport guard for #1024. The public booker collects lead name, email, and
 * phone, so a first-time visitor following an http:// link must be redirected to
 * https:// BEFORE the browser sends anything.
 *
 * That redirect is served by the Worker itself (`worker/index.ts` via
 * `src/lib/http/https-redirect.ts`), NOT by Cloudflare config. A zone Redirect
 * Rule cannot do it: `slate.trypennie.app` is a Workers **Custom Domain**, which
 * makes the Worker the origin, so zone rules are never consulted for it (proven
 * by deploying a valid one and watching plaintext requests pass it). The
 * zone-wide "Always Use HTTPS" toggle would have worked but was rejected on
 * blast radius, since the zone carries nine hostnames, several of them
 * machine-to-machine.
 *
 * So why keep a LIVE canary check for behavior that now lives in code and has
 * unit tests? Because the unit tests prove the decision, not the deployment. A
 * bad deploy, a Custom Domain reattached as a route, or someone reordering the
 * Worker entry would all leave the tests green while production served
 * plaintext. This module holds the pure logic so the verdict is unit-testable
 * off the network; the canary asserts the real site every 30 min (a detective
 * control, matching the after-the-fact model of main-push-guard).
 */

/**
 * The http:// URL to probe for a given smoke base, or `null` when the base isn't
 * a public https host we expect to redirect. A localhost / loopback / already-http
 * base (a local dev run) returns null so the caller SKIPs the check instead of
 * false-failing on a dev server that legitimately serves plain http.
 */
export function httpProbeUrl(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
  url.protocol = "http:";
  return url.toString();
}

const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/**
 * True only when an http:// response is a redirect to an https:// URL. A 200 over
 * plaintext (the audited #1024 gap) or a redirect whose Location is another
 * http:// URL is NOT compliant.
 */
export function isHttpsRedirect(status: number, location: string | null | undefined): boolean {
  if (!REDIRECT_STATUSES.has(status)) return false;
  if (!location) return false;
  return /^https:\/\//i.test(location);
}

/** What the live smoke check should do about an observed redirect state. */
export type RedirectVerdict = "ok" | "warn" | "page";

/**
 * Decide whether a missing http->https redirect should PAGE or merely WARN.
 *
 * The redirect is served by the Worker (see the module header). Paging BEFORE it
 * is live is self-inflicted alert noise, so the guard only pages once we EXPECT
 * the redirect (`expectRedirect`, wired from the EXPECT_HTTPS_REDIRECT repo var,
 * set once the redirect is confirmed live in production). Until then a missing
 * redirect is a visible WARN, not a failure. Once expected, a missing redirect is
 * a real regression and pages.
 */
export function redirectVerdict(isRedirect: boolean, expectRedirect: boolean): RedirectVerdict {
  if (isRedirect) return "ok";
  return expectRedirect ? "page" : "warn";
}

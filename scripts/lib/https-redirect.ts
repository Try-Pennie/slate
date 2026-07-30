/**
 * Transport guard for #1024. The public booker collects lead name, email, and
 * phone, so a first-time visitor following an http:// link must be redirected to
 * https:// BEFORE the browser sends anything.
 *
 * That redirect is Cloudflare config, not code: a **Redirect Rule on the
 * trypennie.app zone scoped to `http.host eq "slate.trypennie.app"`**, NOT the
 * zone-wide "Always Use HTTPS" toggle. The toggle was the obvious move and is
 * what the audit suggested, but the zone carries nine proxied hostnames
 * (automations, le, main, prescreen, rml.smartly, skyfall-offer-wall, slate,
 * smsassign, training), several of which look machine-to-machine, and a blanket
 * 301 would have reached all of them; a client that does not follow redirects,
 * or a POST whose body is dropped on a 301, would have broken silently on a
 * property nobody was changing. So the fix is scoped to Slate's hostname alone.
 *
 * Because it lives in Cloudflare, nothing in this repo can prevent it silently
 * regressing. The smoke canary asserts it live every 30 min (a detective
 * control, matching the after-the-fact model of main-push-guard); this module
 * holds the pure logic so it is unit-testable off the network.
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
 * The redirect is a Cloudflare Redirect Rule created out of band (see the module
 * header). Paging BEFORE it exists is self-inflicted alert noise, so the guard
 * only pages once we EXPECT the redirect (`expectRedirect`, wired from the
 * EXPECT_HTTPS_REDIRECT repo var, set when the rule is deployed). Until then a
 * missing redirect is a visible WARN, not a failure. Once expected, a missing
 * redirect is a real regression and pages.
 */
export function redirectVerdict(isRedirect: boolean, expectRedirect: boolean): RedirectVerdict {
  if (isRedirect) return "ok";
  return expectRedirect ? "page" : "warn";
}

/**
 * Force https at the Worker edge (#1024).
 *
 * The public booker collects lead name, email and phone, so a first-time visitor
 * following an `http://` link must be redirected BEFORE the browser sends any of
 * it. HSTS (#1058) only protects a returning visitor, because the browser has to
 * have seen the header once to honour it.
 *
 * ## Why this is code and not Cloudflare config
 *
 * The audit (and the first two attempts at fixing it) assumed a zone setting:
 * either "Always Use HTTPS" or a scoped Redirect Rule. A Redirect Rule does NOT
 * work here, and the reason is structural rather than a misconfiguration.
 * `slate.trypennie.app` is attached to this Worker as a **Custom Domain**
 * (`custom_domain: true` in `wrangler.jsonc`), and Cloudflare treats a Worker on
 * a Custom Domain as the ORIGIN. Zone Redirect Rules are never consulted for it;
 * Cloudflare's own docs note a redirect rule needs a proxied DNS record it can
 * intercept, which a Custom Domain hostname is not. A valid, correctly scoped
 * rule was deployed and plaintext requests sailed straight past it.
 *
 * The zone-wide "Always Use HTTPS" toggle WOULD work, because it is an SSL/TLS
 * edge setting applied before the pipeline a Custom Domain bypasses. It was
 * rejected on blast radius: the `trypennie.app` zone carries nine proxied
 * hostnames (`automations`, `le`, `main`, `prescreen`, `rml.smartly`,
 * `skyfall-offer-wall`, `slate`, `smsassign`, `training`), several of which look
 * machine-to-machine, and a zone-wide 301 would silently break any of them that
 * calls an `http://` address without following redirects.
 *
 * Doing it here keeps the fix scoped to Slate, in version control, tested, and
 * revertible, instead of a dashboard artifact with no rollback path.
 */

/** Permanent, method-preserving. A 301/302 lets clients rewrite POST to GET and
 *  drop the body, which would turn a booking call into an empty page request. */
const REDIRECT_STATUS = 308;

/**
 * The client's scheme according to Cloudflare, or null when it did not say.
 *
 * `CF-Visitor` is the authoritative signal and is checked FIRST: if Cloudflare
 * normalizes `request.url` to https while the client actually connected over
 * plaintext, the URL alone would report "already secure" and this guard would
 * never fire. A malformed or absent header returns null so the caller falls back
 * to the URL rather than assuming either way.
 */
function cfVisitorScheme(request: Request): "http" | "https" | null {
  const raw = request.headers.get("cf-visitor");
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const scheme =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { scheme?: unknown }).scheme
        : undefined;
    return scheme === "http" || scheme === "https" ? scheme : null;
  } catch {
    // Unreadable header: not an error worth failing a page load over, and the
    // URL fallback below still gets a say.
    return null;
  }
}

/**
 * A 308 to the https form of this request, or null to let it through untouched.
 *
 * **The fail-safe direction is the one decision that matters here, and it points
 * at "do not redirect".** Redirecting a request that is ALREADY secure loops the
 * browser forever, which is far worse than the gap being closed. So anything
 * this cannot positively establish as plaintext passes through, and the smoke
 * canary (`scripts/lib/https-redirect.ts`) keeps reporting that the redirect is
 * not live. That is the opposite of the usual fail-closed instinct, and it is
 * deliberate: here the closed position is the harmful one.
 */
export function httpsRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  const visitor = cfVisitorScheme(request);

  // Cloudflare's word wins when it gave one; otherwise trust the URL.
  const isPlaintext = visitor !== null ? visitor === "http" : url.protocol === "http:";
  if (!isPlaintext) return null;

  // Rebuild from the parsed URL so host, path, query and any port survive
  // exactly, rather than string-splicing the scheme.
  url.protocol = "https:";
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url.toString() },
  });
}

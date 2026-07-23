/**
 * Defense-in-depth response headers for the authenticated staff surfaces
 * (/admin, /me, /login), applied by the middleware, whose matcher is exactly
 * those paths (#592).
 *
 * `frame-ancestors 'none'` + `X-Frame-Options: DENY` stop a hostile page from
 * embedding a staff page to clickjack a privileged action. The rest is baseline
 * hardening. This is deliberately NOT applied to `/book` or `widget.js`: the
 * booker MUST stay embeddable on partner pages (see slate-embed-contract).
 *
 * The CSP is `frame-ancestors` ONLY (no `script-src`/`default-src`, which would
 * need nonces for Next's inline runtime and could silently break the app). A full
 * content CSP is a separate effort.
 *
 * HSTS is intentionally NOT here: it is transport-only (does not restrict framing)
 * so it is served on EVERY response via next.config `headers()` (#1024), including
 * the embeddable booker. Keeping it out of this staff-only bundle avoids a
 * duplicate `Strict-Transport-Security` header on /admin, /me, /login.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

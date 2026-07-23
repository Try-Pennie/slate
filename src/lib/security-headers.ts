/**
 * FRAMING defense for the authenticated staff surfaces (/admin, /me, /login),
 * applied by the middleware, whose matcher is exactly those paths (#592).
 *
 * `frame-ancestors 'none'` + `X-Frame-Options: DENY` stop a hostile page from
 * embedding a staff page to clickjack a privileged action. This bundle is
 * deliberately NOT applied to `/book` or `widget.js`: the booker MUST stay
 * embeddable on partner pages (see slate-embed-contract), so the framing headers
 * are the ONLY ones scoped to staff paths.
 *
 * The CSP is `frame-ancestors` ONLY (no `script-src`/`default-src`, which would
 * need nonces for Next's inline runtime and could silently break the app). A full
 * content CSP is a separate effort.
 *
 * The non-framing hardening (HSTS, nosniff, Referrer-Policy) is intentionally NOT
 * here: none of it restricts framing, so it is served on EVERY response via
 * next.config `headers()` (HSTS #1024; nosniff + Referrer-Policy #1030) including
 * the embeddable booker, the manage-by-token pages, and /api. Keeping it out of
 * this staff-only bundle avoids a duplicate header on /admin, /me, /login.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

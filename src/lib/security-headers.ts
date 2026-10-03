/**
 * FRAMING defense for the authenticated staff surfaces (/admin, /me, /login),
 * applied by the middleware on exactly those paths (#592).
 *
 * `X-Frame-Options: DENY` stops a legacy browser embedding a staff page to
 * clickjack a privileged action. This bundle is deliberately NOT applied to
 * `/book` or `widget.js`: the booker MUST stay embeddable on partner pages (see
 * slate-embed-contract).
 *
 * The modern half of the same rule, `frame-ancestors 'none'`, used to live here as
 * its own `Content-Security-Policy` header. Since #2575 it is a directive of the
 * one ENFORCED policy (`src/lib/csp.ts`, built with `frameable: false` on staff
 * paths), because two `Content-Security-Policy` values cannot both be the header
 * Next reads its nonce from: the framing only one won that read, carried no nonce,
 * and the staff pages got none.
 *
 * The non-framing hardening (HSTS, nosniff, Referrer-Policy) is intentionally NOT
 * here: none of it restricts framing, so it is served on EVERY response via
 * next.config `headers()` (HSTS #1024; nosniff + Referrer-Policy #1030) including
 * the embeddable booker, the manage-by-token pages, and /api. Keeping it out of
 * this staff-only bundle avoids a duplicate header on /admin, /me, /login.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
};

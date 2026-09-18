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
 * The ENFORCING policy here is `frame-ancestors` ONLY, and stays that way. The
 * script policy (`src/lib/csp.ts`, #2565) is served REPORT ONLY, on a separate
 * header, by the same middleware; enforcing it is a later change gated on reading
 * real violations rather than on it looking right. The comment that used to sit
 * here said a content CSP "could silently break the app" and left it at that,
 * which is a deferral with no owner and no date. What it was worried about was
 * measured before any of this was written: see the header of `csp.ts`.
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

/**
 * Slate's two sign in pages (#4379), and how a sign in finds its way back to the right one.
 *
 * Staff sign in on `/login`, with Google only. The call center partner's scheduling
 * coordinators sign in on `/partner/sign-in`, with their work Microsoft account only
 * (docs/design/partner-sign-in.html, D1 and D3), so nobody is shown a way in they cannot
 * use. A refused sign in must come back to the page whose button was pressed, or the
 * person reads the reason beside a button that can never work for them.
 *
 * Once the code exchange has run, the sign in callback knows which it was from the
 * identities GoTrue keeps on the auth user, and that decides. Before it (a hand off that
 * came back with no code, which is what a cancelled or refused Microsoft consent does, or a
 * code that would not exchange) nothing on the server can say, so each page marks the
 * browser as it starts the redirect: the partner page sets `slate_sign_in_from=partner`, the
 * staff page clears it. The mark only ever chooses between these two fixed paths, so a
 * forged one can do no more than show somebody the other page's sentence.
 *
 * A signed out visit is the other half (#4398): nothing has started yet, so the browser's
 * record of which page its last sign in SUCCEEDED on (`slate_last_sign_in_page`, written by
 * the callback) chooses where to send it, so a coordinator is not sent to /login, whose only
 * button is Google. The same two fixed paths, the same exact match, and the same limit: it
 * picks a page to show and lets nobody in.
 *
 * Pure, no imports: the browser and the callback both read it.
 */

export const STAFF_SIGN_IN_PATH = "/login";
export const PARTNER_SIGN_IN_PATH = "/partner/sign-in";

export type SignInPage = "staff" | "partner";

export function signInPathFor(page: SignInPage): string {
  return page === "partner" ? PARTNER_SIGN_IN_PATH : STAFF_SIGN_IN_PATH;
}

/** Exactly the two sign in pages, which the middleware treats alike (#4379). */
export function isSignInPath(pathname: string): boolean {
  return pathname === STAFF_SIGN_IN_PATH || pathname === PARTNER_SIGN_IN_PATH;
}

/** The mark a sign in page leaves on the browser as it starts the redirect. */
export const SIGN_IN_FROM_COOKIE = "slate_sign_in_from";

/**
 * Ten minutes: long enough for a Microsoft consent screen, a password and a second factor,
 * short enough that a staff sign in on this browser tomorrow is not read as a partner's.
 */
export const SIGN_IN_FROM_MAX_AGE_S = 600;

/** Which page a sign in started from, by its mark: partner only for exactly that value. */
export function signInPageFromCookie(value: string | undefined | null): SignInPage {
  return value === "partner" ? "partner" : "staff";
}

/**
 * The `document.cookie` assignment a page makes as it starts a sign in: the partner page
 * sets the mark, the staff page clears it. Lax, so the callback's top level navigation back
 * from Supabase carries it; not httpOnly, because script writes it; Secure over https.
 */
export function signInFromCookie(page: SignInPage, protocol: string): string {
  const secure = protocol === "https:" ? "; secure" : "";
  return page === "partner"
    ? `${SIGN_IN_FROM_COOKIE}=partner; path=/; max-age=${SIGN_IN_FROM_MAX_AGE_S}; samesite=lax${secure}`
    : `${SIGN_IN_FROM_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
}

/**
 * The record of which sign in page this browser's last SUCCESSFUL sign in belongs to (#4398).
 * The callback writes `partner` on a coordinator's Microsoft sign in and clears it on a Google
 * one; refusals leave it alone. Unlike the mark above, nothing is written before a sign in has
 * succeeded, so it can outlive the session and still be true.
 */
export const LAST_SIGN_IN_PAGE_COOKIE = "slate_last_sign_in_page";

/**
 * 400 days: the most a browser keeps a cookie (Chrome caps Max-Age there), and far past the
 * 30 days a session can last (`SESSION_TIME_BOX_MS`), so a coordinator whose session aged out,
 * or who was away a month, is still sent to their own page. If it is ever wrong for whoever
 * uses this browser next, their Google sign in clears it.
 */
export const LAST_SIGN_IN_PAGE_MAX_AGE_S = 400 * 24 * 60 * 60;

/**
 * How the callback writes (or, with `maxAge` 0, clears) the record: httpOnly, because only the
 * server writes or reads it; Lax, because opening /coordinator from a bookmark or another site
 * is a cross site navigation and Strict would drop it on exactly that visit; whole site; and
 * Secure in production, as the session stamps are.
 *
 * Clearing (`maxAge` 0) also sets an Expires in 1970. Measured in the browser check
 * (e2e/tests/10-auth.spec.ts): the callback's `Max-Age=0` reached the browser WITHOUT its
 * Max-Age, so the record was kept as an empty session cookie rather than removed. Next
 * re-parses the route handler's Set-Cookie headers on the way out (most likely to merge the
 * ones the Supabase client writes through `next/headers`), and that parser
 * (`parseSetCookie` in its bundled `@edge-runtime/cookies`) drops every falsy attribute, a
 * Max-Age of 0 included. A past Expires survives it, and removes the cookie either way.
 */
export function lastSignInPageCookieOptions(maxAge: number) {
  return {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
    ...(maxAge === 0 ? { expires: new Date(0) } : {}),
  };
}

/**
 * Where to send a browser that has to sign in (signed out, aged out, or just signed out), by
 * its record: the partner page only for exactly `partner`, and /login for anything else, a
 * forged or garbled value included. Only ever one of the two fixed paths, never a URL from
 * the cookie.
 */
export function signInPathForBrowser(lastSignInPage: string | undefined | null): string {
  return signInPathFor(signInPageFromCookie(lastSignInPage));
}

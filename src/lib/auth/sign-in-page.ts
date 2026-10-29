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

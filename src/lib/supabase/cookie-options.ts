/**
 * The attributes Slate's auth cookies are written with (#3112).
 *
 * `@supabase/ssr` defaults every auth cookie to `httpOnly: false`, a 400 day `maxAge` and no
 * explicit `Secure`, so the access and refresh tokens were readable by any script on a staff
 * page and outlived any reasonable idle period by a year. Two facts decide what can change:
 *
 *  - Only the SERVER ever needs the session. The one browser client (`/login`) exists to
 *    start the Google redirect, which writes the PKCE code verifier from script; the
 *    callback exchanges it server side and writes the session from there. So cookies the
 *    server writes are `httpOnly`, and the browser client's own writes are not, because a
 *    cookie written through `document.cookie` with `HttpOnly` is dropped by the browser and
 *    the verifier would never reach the callback.
 *  - The library FORCES its 400 day `maxAge` over any `cookieOptions.maxAge` it is given, so
 *    the clamp has to be applied where the cookie is actually set, in each `setAll`.
 *
 * `Secure` is on in production and off in development, because a dev server answers on
 * http://localhost, where some browsers refuse a `Secure` cookie outright.
 */
import { SESSION_IDLE_MS } from "@/lib/auth/session-age";

/** How long an idle staff session survives. Every token refresh (roughly hourly while a
 *  page is in use) re-sets the cookie, so this bounds IDLE time, not a working day. Held
 *  equal to the #3084 idle limit (`SESSION_IDLE_MS`), so the browser drops an idle session
 *  on the same day the server would refuse it; the 30 day total is judged separately,
 *  from the sign in stamp, because a refresh moves this cookie's expiry forward. */
export const AUTH_COOKIE_MAX_AGE_SECONDS = SESSION_IDLE_MS / 1000;

/** Whether auth cookies carry `Secure`. Off only for a development server. */
export function authCookieSecure(): boolean {
  return process.env.NODE_ENV === "production";
}

/** What the server clients hand `@supabase/ssr` as `cookieOptions`. */
export function serverAuthCookieOptions() {
  return { httpOnly: true, secure: authCookieSecure(), sameSite: "lax" as const, path: "/" };
}

/** What the browser client hands it: never `httpOnly`, see above. */
export function browserAuthCookieOptions(protocol: string) {
  return { httpOnly: false, secure: protocol === "https:", sameSite: "lax" as const, path: "/" };
}

/**
 * The options a server `setAll` writes one cookie with: the library's own, hardened. A
 * removal (`maxAge: 0`) stays a removal; anything longer is clamped.
 */
export function hardenAuthCookie<T extends { maxAge?: number }>(
  options: T | undefined,
): T & { httpOnly: true; secure: boolean; sameSite: "lax"; maxAge: number } {
  const maxAge = options?.maxAge;
  return {
    ...(options as T),
    ...serverAuthCookieOptions(),
    httpOnly: true,
    maxAge: maxAge === 0 ? 0 : Math.min(maxAge ?? AUTH_COOKIE_MAX_AGE_SECONDS, AUTH_COOKIE_MAX_AGE_SECONDS),
  };
}

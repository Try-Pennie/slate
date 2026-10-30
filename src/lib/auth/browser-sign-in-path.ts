import { cookies } from "next/headers";
import { LAST_SIGN_IN_PAGE_COOKIE, signInPathForBrowser } from "./sign-in-page";

/**
 * The sign in page this browser last signed in on (#4412), for a page's own signed out
 * redirect. The middleware already sends a visit with NO session to it (#4398), but a browser
 * still holding a session the gate refuses reaches the page itself, which then decided
 * `/login` alone, so a partner coordinator in that state landed on the Google only staff
 * login. Only ever one of the two fixed paths: `signInPathForBrowser` answers `/login` for
 * anything but exactly `partner`.
 */
export async function browserSignInPath(): Promise<string> {
  const jar = await cookies();
  return signInPathForBrowser(jar.get(LAST_SIGN_IN_PAGE_COOKIE)?.value);
}

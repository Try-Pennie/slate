"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { IMPERSONATE_COOKIE } from "@/lib/auth/impersonation";
import { log } from "@/lib/log";
import { THEME_COOKIE } from "@/lib/theme/boot";
import { SESSION_STAMP_COOKIES } from "@/lib/auth/session-age";
import { LAST_SIGN_IN_PAGE_COOKIE, signInPathForBrowser } from "@/lib/auth/sign-in-page";

/**
 * End the current staff session (#1031). Before this there was no sign-out
 * anywhere in the app, so a session on a shared or lost machine lived until the
 * Supabase refresh token expired. Exposed in the account menu on /admin and /me.
 *
 * Signs out of Supabase (revokes the refresh token + clears the auth cookies),
 * then clears Slate's own session cookies (the "view as" cookie and the theme
 * cookie, so neither follows the next person on a shared machine) and lands on
 * the sign in page this browser last signed in on: /login, or the partner page
 * after a coordinator's Microsoft sign in (#4398).
 *
 * Fail loud, but never strand the user: auth-js `_signOut` early-returns BEFORE
 * removing the local session when the server-side revoke errors (a 5xx / network
 * blip; 401/403/404 are treated as already-signed-out and still clear). So on a
 * real error we clear the `sb-*` auth cookies ourselves, guaranteeing the local
 * session is dead on this device regardless, and surface the failure to the logs.
 */
// outcome-ok: it ends the session and lands on the login page, which is the confirmation
export async function signOut(): Promise<void> {
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signOut();
  const store = await cookies();
  if (error) {
    log.warn("auth-signout", { msg: "supabase signOut failed", error: error.message });
    for (const c of store.getAll()) {
      if (c.name.startsWith("sb-")) store.delete(c.name);
    }
  }
  store.delete(IMPERSONATE_COOKIE);
  store.delete(THEME_COOKIE);
  // #3084: the session's age stamps, so nothing of this sign in outlives it.
  for (const name of SESSION_STAMP_COOKIES) store.delete(name);
  // #4398: to the sign in page this browser last signed in on, so a coordinator lands where
  // they can sign back in, not on /login, whose only button is Google. That record is left in
  // place: it only says which page to show, and lets nobody in.
  redirect(signInPathForBrowser(store.get(LAST_SIGN_IN_PAGE_COOKIE)?.value));
}

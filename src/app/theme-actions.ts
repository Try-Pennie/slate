"use server";

import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { realCurrentUser } from "@/lib/auth";
import {
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  isThemePreference,
} from "@/lib/theme/boot";

/**
 * Persist the signed-in user's theme preference to their account (so it follows
 * across devices) and to the `slate-theme` cookie (so the boot script picks it
 * up before the next paint). Tied to the REAL user, so impersonation never
 * changes someone else's theme.
 *
 * #2100: every way this can fail now REJECTS, and the control says so. It used
 * to return void whatever happened: an unchecked update, a silent skip when
 * nobody was signed in, and a silent skip on a value outside the vocabulary. A
 * write that never landed was indistinguishable from one that did, and the cost
 * lands later, on the next sign in, when the account's old theme comes back.
 *
 * The cookie is written FIRST and deliberately survives a failure below: the
 * person's own browser keeps what they chose either way, and what a failure
 * costs them is their other devices.
 */
export async function setThemePreference(pref: string): Promise<void> {
  if (!isThemePreference(pref)) {
    throw new Error(`not a theme preference: ${pref}`);
  }

  const store = await cookies();
  store.set(THEME_COOKIE, pref, {
    path: "/",
    maxAge: THEME_COOKIE_MAX_AGE,
    sameSite: "lax",
  });

  const me = await realCurrentUser();
  if (!me) {
    throw new Error("no theme preference recorded: nobody is signed in");
  }

  const { error } = await supabaseAdmin()
    .from("users")
    .update({ theme_preference: pref })
    .eq("id", me.id);
  if (error) {
    throw new Error(`theme preference not recorded: ${error.message}`);
  }
}

"use server";

import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { realCurrentUser } from "@/lib/auth";
import type { ThemePreference } from "@/lib/db/types";

const VALID = new Set<ThemePreference>(["system", "light", "dark"]);

function isThemePreference(v: string): v is ThemePreference {
  return VALID.has(v as ThemePreference);
}
const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Persist the signed-in user's theme preference to their account (so it follows
 * across devices) and to the `slate-theme` cookie (so the no-flash script picks
 * it up on the next load). Tied to the REAL user, so impersonation never changes
 * someone else's theme. The client also applies it immediately, so this is a
 * fire-and-forget persist.
 */
export async function setThemePreference(pref: string): Promise<void> {
  if (!isThemePreference(pref)) return;
  const store = await cookies();
  store.set("slate-theme", pref, {
    path: "/",
    maxAge: ONE_YEAR,
    sameSite: "lax",
  });
  const me = await realCurrentUser();
  if (me) {
    await supabaseAdmin()
      .from("users")
      .update({ theme_preference: pref })
      .eq("id", me.id);
  }
}

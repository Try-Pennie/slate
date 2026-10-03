import { createBrowserClient } from "@supabase/ssr";
import { publicSupabasePublishableKey, publicSupabaseUrl } from "@/lib/env";
import type { Database } from "@/lib/db/schema";
import { browserAuthCookieOptions } from "@/lib/supabase/cookie-options";

/**
 * The one browser client, which `/login` uses to start the Google redirect. Its cookie
 * (the PKCE code verifier) is written from script, so it is never httpOnly (#3112):
 * a browser drops a `document.cookie` write that asks for it.
 */
export function supabaseBrowser() {
  return createBrowserClient<Database>(publicSupabaseUrl(), publicSupabasePublishableKey(), {
    cookieOptions: browserAuthCookieOptions(
      typeof window === "undefined" ? "https:" : window.location.protocol,
    ),
  });
}

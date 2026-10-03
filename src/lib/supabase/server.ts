import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { publicSupabasePublishableKey, publicSupabaseUrl } from "@/lib/env";
import type { Database } from "@/lib/db/schema";
import { supabaseFetch } from "@/lib/supabase/fetch";
import { hardenAuthCookie, serverAuthCookieOptions } from "@/lib/supabase/cookie-options";

/**
 * Anon-key server client bound to the request's auth cookies. Used to identify
 * the signed-in user (auth.getUser) in route handlers / server components.
 * Privileged data access should go through `supabaseAdmin()` after an auth check.
 *
 * Its cookies are httpOnly, Secure in production and clamped to the idle limit
 * (#3112, `cookie-options.ts`). The sign in callback's code exchange writes the
 * session through this client, so that is where those attributes are set.
 */
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient<Database>(publicSupabaseUrl(), publicSupabasePublishableKey(), {
    global: { fetch: supabaseFetch },
    cookieOptions: serverAuthCookieOptions(),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, hardenAuthCookie(options));
          }
        } catch {
          // Called from a Server Component where cookies are read-only.
          // Session refresh is handled by middleware instead.
        }
      },
    },
  });
}

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { publicSupabasePublishableKey, publicSupabaseUrl } from "@/lib/env";
import type { Database } from "@/lib/db/schema";

/**
 * Anon-key server client bound to the request's auth cookies. Used to identify
 * the signed-in user (auth.getUser) in route handlers / server components.
 * Privileged data access should go through `supabaseAdmin()` after an auth check.
 */
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient<Database>(publicSupabaseUrl(), publicSupabasePublishableKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component where cookies are read-only.
          // Session refresh is handled by middleware instead.
        }
      },
    },
  });
}

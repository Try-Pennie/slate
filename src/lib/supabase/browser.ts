import { createBrowserClient } from "@supabase/ssr";
import { publicSupabasePublishableKey, publicSupabaseUrl } from "@/lib/env";
import type { Database } from "@/lib/db/schema";

export function supabaseBrowser() {
  return createBrowserClient<Database>(
    publicSupabaseUrl(),
    publicSupabasePublishableKey(),
  );
}

import { createClient } from "@supabase/supabase-js";
import { publicSupabaseUrl, supabaseSecretKey } from "@/lib/env";
import type { Database } from "@/lib/db/schema";

/**
 * Secret-key client (replaces the legacy service_role key). Bypasses RLS — use
 * ONLY in server code (route handlers, server actions, cron). Never import from
 * a client component.
 */
let cached: ReturnType<typeof createClient<Database>> | null = null;

export function supabaseAdmin() {
  if (!cached) {
    cached = createClient<Database>(publicSupabaseUrl(), supabaseSecretKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

import { createClient } from "@supabase/supabase-js";
import { publicSupabaseUrl, supabaseSecretKey } from "@/lib/env";
import type { Database } from "@/lib/db/schema";
import { loadtestSupabaseFetch } from "@/lib/loadtest-fault";

/**
 * Secret-key client (replaces the legacy service_role key). Bypasses RLS — use
 * ONLY in server code (route handlers, server actions, cron). Never import from
 * a client component.
 */
let cached: ReturnType<typeof createClient<Database>> | null = null;

export function supabaseAdmin() {
  if (!cached) {
    // #3104: null everywhere but a load run faulting the database, so production
    // passes no fetch and the client is exactly what it was.
    const faulting = loadtestSupabaseFetch((input, init) => fetch(input, init));
    cached = createClient<Database>(publicSupabaseUrl(), supabaseSecretKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(faulting ? { global: { fetch: faulting } } : {}),
    });
  }
  return cached;
}

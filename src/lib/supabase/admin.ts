import { createClient } from "@supabase/supabase-js";
import { publicSupabaseUrl, supabaseSecretKey } from "@/lib/env";
import type { Database } from "@/lib/db/schema";
import { supabaseFetch, supabaseFetchOver } from "@/lib/supabase/fetch";
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
    // gets the plain deadline fetch.
    // deadline-ok: the fault injector sits INSIDE supabaseFetchOver, whose deadline bounds it
    const faulting = loadtestSupabaseFetch((input, init) => fetch(input, init));
    cached = createClient<Database>(publicSupabaseUrl(), supabaseSecretKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
      // #3102 over #3104: the deadline sits OUTSIDE the load run's fault
      // injector, so an injected hang is cut by the same deadline a real one is.
      global: { fetch: faulting ? supabaseFetchOver(faulting) : supabaseFetch },
    });
  }
  return cached;
}

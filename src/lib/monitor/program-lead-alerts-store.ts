/**
 * The reads behind the program leads alerts (#4392), kept out of the monitor route so the
 * tables and bounds are in one place. Both THROW on a failure: a zero here would read as
 * "no fallbacks" (clearing a real page) or "no registrations" (paging over a read that
 * never happened).
 */
import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap, unwrapCount } from "@/lib/db/result";

type Db = ReturnType<typeof supabaseAdmin>;

/** Fallbacks to real times counted on one Eastern day: its one row, or 0 with none. */
export async function readProgramLeadFallbackDayCount(db: Db, day: string): Promise<number> {
  const row = unwrap(
    await db.from("program_lead_outcomes").select("occurrences").eq("day", day).eq("kind", "times_fallback").maybeSingle(),
    "monitor program lead fallbacks",
  ) as { occurrences: number } | null;
  return row?.occurrences ?? 0;
}

/**
 * Program leads registered at or after `sinceIso`, counted on the server. Every
 * registration, a first one or a repeat, moves `last_registered_at` (migration 0213), so
 * zero means nobody was registered in the window at all.
 */
export async function countProgramLeadsRegisteredSince(db: Db, sinceIso: string): Promise<number> {
  return unwrapCount(
    await db.from("program_leads").select("lead_key", { count: "exact", head: true }).gte("last_registered_at", sinceIso),
    "monitor program lead registrations",
  );
}

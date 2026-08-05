import type { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";

/**
 * Customer bookings created since `sinceIso`, for the low-volume alarm (#370).
 *
 * The alarm exists to notice that CUSTOMERS have stopped booking, so the one thing
 * it must never count is Slate booking against itself. The smoke canary makes
 * roughly 8 bookings every 6 hours and will do so forever (#396), and a floor
 * measured against those cannot tell a quiet afternoon from a dead funnel: today
 * the last 6 hours hold 8 bookings and 0 of them are real.
 *
 * `bookings` has no is_test column, so test-ness is a property of the BUCKET, which
 * is why this is an inner join with an embedded filter rather than a plain column
 * predicate. Verified against the live API before it was written: the same window
 * returns 8 unfiltered and 0 filtered, with `head: true` and an exact count, so
 * this still costs one subrequest on a budget four cron lanes share.
 *
 * Returns null when the read FAILED, never 0 (#1158, and the wider rule in
 * AGENTS.md): zero is the value that pages, so an errored query must present as
 * unverified and let the caller skip the tick rather than invent a drought.
 */
export async function countCustomerBookingsSince(
  db: ReturnType<typeof supabaseAdmin>,
  sinceIso: string,
): Promise<number | null> {
  // cap-safe: a head-only exact count returns no rows.
  const { count, error } = await db
    .from("bookings")
    .select("*, buckets!inner(is_test)", { count: "exact", head: true })
    .eq("buckets.is_test", false)
    .gte("created_at", sinceIso);
  if (error) {
    log.error("monitor", { msg: "booking volume count read failed", since: sinceIso }, error);
    return null;
  }
  return count ?? 0;
}

/**
 * The booking pace read behind Team capacity's day cards (#4104): the org's newest readings in
 * capacity_fill_readings (#4102), whose pace and estimate columns the capacity-fill lane writes
 * (#4103). `judgePace` (./team-capacity-pace) decides what they say.
 *
 * Server only, through the secret key client, and scoped to the caller's own org. A failed read
 * is returned as failed, never as no readings: no readings is launch, which every card would say as
 * "Pace shows after 3 hours of readings" for as long as the read kept failing.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { PACE_COLUMNS, type PaceRead, type PaceRow } from "./team-capacity-pace";

/**
 * Enough rows for the newest run whole: one run writes one row per page day, at most eight (a
 * seven day window led by today after the evening cutoff), so twice that with room to spare.
 */
export const PACE_READ_LIMIT = 24;

export async function readPaceRows(orgId: string): Promise<PaceRead> {
  try {
    // cap-safe: bounded by PACE_READ_LIMIT, newest first; only the newest run's rows are read.
    const rows = unwrap(
      await supabaseAdmin()
        .from("capacity_fill_readings")
        .select(PACE_COLUMNS)
        .eq("org_id", orgId)
        .order("read_at", { ascending: false })
        .limit(PACE_READ_LIMIT),
      "booking pace readings",
    ) as PaceRow[] | null;
    if (!Array.isArray(rows)) throw new Error("the booking pace read returned no list");
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, err };
  }
}

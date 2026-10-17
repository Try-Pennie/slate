import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import type { RateWindowState } from "@/lib/monitor/booking-failure-rate";
import type { BookingFailureRateState } from "@/lib/db/types";

/**
 * One rolling window of five minute samples kept in its own row of
 * `booking_failure_rate_state`, under a fixed key (#2377, shared since by the follow up
 * drain share's store). Every signal that reuses the failure rate's window machinery
 * keeps its state the same way, so the read and the write live here once rather than
 * once per signal.
 *
 * The read goes through `unwrap`: a failed read and a first run are the same empty
 * answer otherwise, and a window silently reset would report an interval it never
 * measured (#277, #1134). The write is an upsert on the fixed key, so a retry or an
 * overlapping tick can never leave a second row ("assume it runs twice").
 */
export async function loadRateWindowRow(key: string): Promise<RateWindowState | null> {
  const row = unwrap(
    await supabaseAdmin()
      .from("booking_failure_rate_state")
      .select("key, day, attempts, failures, by_code, refusals, samples")
      .eq("key", key)
      .maybeSingle(),
    `booking_failure_rate_state (${key})`,
  ) as BookingFailureRateState | null;
  if (!row) return null;
  return {
    day: row.day,
    attempts: row.attempts,
    failures: row.failures,
    byCode: row.by_code ?? {},
    samples: row.samples ?? [],
  };
}

export async function saveRateWindowRow(key: string, state: RateWindowState): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("booking_failure_rate_state")
    .upsert(
      {
        key,
        day: state.day,
        attempts: state.attempts,
        failures: state.failures,
        by_code: state.byCode,
        // Not used by these signals. Written as an empty object because the column is
        // NOT NULL and its default applies only on INSERT, so the second upsert would
        // fail without it (the reminder store's reason).
        refusals: {},
        samples: state.samples,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
  if (error) throw new Error(`booking_failure_rate_state (${key}) write failed: ${error.message}`);
}

/**
 * The IO half of the booking-failure-rate page (#1313): today's cumulative tally
 * and the single rolling-window state row. Kept out of booking-failure-rate.ts so
 * that module stays node-testable with no `@/` imports.
 *
 * Both reads go through `unwrap`, which is the whole point of the split. An empty
 * result here is INDISTINGUISHABLE from a healthy one: a tally read that failed
 * looks like a day with no failures, and a state read that failed looks like a
 * first run. Either would let the check report health it never measured, which is
 * the defect class in #277 / #1134 / #1165. So they throw, and the caller reports
 * the tick as unverified.
 */
import { DateTime } from "luxon";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { normalizeMix, type RawMix } from "@/lib/monitor/booking-api-outcome";
import type { OutcomeReading, RateWindowState } from "@/lib/monitor/booking-failure-rate";
import type { BookingFailureRateState } from "@/lib/db/types";

/** The whole roster runs in one zone, and the tally buckets by ET day (#832), so
 *  the window has to ask about the same day the counter is keyed on. */
const ROSTER_ZONE = "America/New_York";

/** The fixed primary key of the one state row. */
const STATE_KEY = "monitor";

/** Load the rolling window, or null when there is none yet. Throws on a read
 *  error, so "no state" and "could not read the state" stay distinct. */
export async function loadRateState(): Promise<RateWindowState | null> {
  const row = unwrap(
    await supabaseAdmin()
      .from("booking_failure_rate_state")
      .select("key, day, attempts, failures, by_code, samples")
      .eq("key", STATE_KEY)
      .maybeSingle(),
    "booking_failure_rate_state",
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

/** Write the advanced window back. Upsert on the fixed key, so a retry or a
 *  concurrent tick can never leave a second row behind ("assume it runs twice"). */
export async function saveRateState(state: RateWindowState): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("booking_failure_rate_state")
    .upsert(
      {
        key: STATE_KEY,
        day: state.day,
        attempts: state.attempts,
        failures: state.failures,
        by_code: state.byCode,
        samples: state.samples,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
  if (error) throw new Error(`booking_failure_rate_state write failed: ${error.message}`);
}

/**
 * Today's cumulative totals, via the existing aggregate RPC (#418), which returns
 * ONE jsonb row and so is cap-safe by construction. `attempts` is every outcome
 * summed (a customer who was deduped or sent to confirm still tried), `failures`
 * is the error outcome, and `byCode` is the error slice so the page can name what
 * is actually failing.
 */
export async function readTodayOutcomes(nowMs: number): Promise<OutcomeReading> {
  const day = DateTime.fromMillis(nowMs, { zone: ROSTER_ZONE }).toISODate() ?? "";
  const raw = unwrap(
    await supabaseAdmin().rpc("booking_api_outcome_mix", { p_since: day }),
    "booking_api_outcome_mix",
  ) as RawMix | null;
  const mix = normalizeMix(raw);
  const failures = mix.outcomes.find((o) => o.outcome === "error")?.count ?? 0;
  const byCode: Record<string, number> = {};
  for (const e of mix.errors) byCode[e.code] = e.count;
  return { day, attempts: mix.total, failures, byCode };
}

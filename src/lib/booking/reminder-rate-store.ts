import { DateTime } from "luxon";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import type { RateWindowState } from "@/lib/monitor/booking-failure-rate";
import type { BookingFailureRateState } from "@/lib/db/types";

/**
 * The IO half of the reminder failure share (#2496), kept out of `reminder-rate.ts`
 * so every branch of the judgement stays drivable with no database.
 *
 * ## Why this shares `booking_failure_rate_state` rather than a table of its own
 *
 * The row is the same thing: one rolling window of per interval samples, keyed by a
 * fixed text primary key. The sibling check (#1313) keeps its window under the key
 * `monitor`; this one keeps its window under `booking_reminders`. A second table
 * would carry the same five columns for the same purpose and give two places to
 * look for "the rolling window", and the primary key already makes a second row per
 * signal structurally impossible.
 *
 * The three counters beside the window mean something for this key too. `day` is the
 * ET calendar day the day to date totals belong to, and `attempts` / `failures` /
 * `by_code` are those totals: for the sibling they are the BASELINE the next delta
 * is differenced against, because it reads a counter somebody else writes; this lane
 * measures its own tick, so they are simply what it has attempted today, which is
 * the number a person asks for when they want to know whether the wave went out.
 *
 * Both reads go through `unwrap`, which is the whole point of the split. A read that
 * failed and a lane with nothing to report are the same empty answer here, so a
 * swallowed error would report a healthy share the check never measured (#277,
 * #1134, #1165).
 */

/** The whole roster runs in one zone and the day to date counters bucket by ET day,
 *  matching the sibling window's `day` so one table holds one meaning of "day". */
const ROSTER_ZONE = "America/New_York";

/** This signal's row. A DIFFERENT key from the monitor lane's window, so the two
 *  can never advance each other's samples. */
const STATE_KEY = "booking_reminders";

/** The ET calendar day `nowMs` falls in, which is what the day to date counters are
 *  keyed on. */
export function reminderRateDay(nowMs: number): string {
  return DateTime.fromMillis(nowMs, { zone: ROSTER_ZONE }).toISODate() ?? "";
}

/** Load the rolling window, or null when there is none yet. THROWS on a read error,
 *  so "no window yet" and "could not read the window" stay distinct: the first is a
 *  first run, the second must claim nothing in either direction. */
export async function loadReminderRateState(): Promise<RateWindowState | null> {
  const row = unwrap(
    await supabaseAdmin()
      .from("booking_failure_rate_state")
      .select("key, day, attempts, failures, by_code, refusals, samples")
      .eq("key", STATE_KEY)
      .maybeSingle(),
    "booking_failure_rate_state (booking_reminders)",
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

/** Write the advanced window back. Upsert on the fixed key, so a retry or an
 *  overlapping tick can never leave a second row behind ("assume it runs twice"). */
export async function saveReminderRateState(state: RateWindowState): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("booking_failure_rate_state")
    .upsert(
      {
        key: STATE_KEY,
        day: state.day,
        attempts: state.attempts,
        failures: state.failures,
        by_code: state.byCode,
        // Not used by this signal: the self inflicted refusal baseline belongs to
        // the booking API's own window. Written as an empty object rather than left
        // out, because the column is NOT NULL and a default that only applies on
        // INSERT would fail the second upsert.
        refusals: {},
        samples: state.samples,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
  if (error) {
    throw new Error(`booking_failure_rate_state (booking_reminders) write failed: ${error.message}`);
  }
}

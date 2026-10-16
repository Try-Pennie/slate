import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import type { RateWindowState, OutcomeReading } from "@/lib/monitor/booking-failure-rate";
import { followUpReading } from "@/lib/monitor/follow-up-drain-rate";
import type { TodayMix } from "@/lib/monitor/booking-failure-rate-store";
import type { BookingFailureRateState } from "@/lib/db/types";

/**
 * The IO half of the follow up drain share (#3267), kept out of
 * `follow-up-drain-rate.ts` so every branch of the judgement stays drivable with no
 * database.
 *
 * The window shares `booking_failure_rate_state` with the failure share (key
 * `monitor`) and the reminder share (key `booking_reminders`, #2496), for the reason
 * the reminder store gives: the row is the same thing, one rolling window of five
 * minute samples under a fixed primary key, so a second row per signal is
 * structurally impossible and no migration is needed. `attempts` and `failures` here
 * are today's committed confirms and the ones left to the drain, the baseline the
 * next delta is taken against.
 *
 * Both reads go through `unwrap`: a failed read and a first run are the same empty
 * answer otherwise, and a window silently reset would report an hour it never
 * measured (#277, #1134).
 */
const STATE_KEY = "booking_follow_up";

/** Today's counts as the window reads them, off the tally read the failure share
 *  already made: the confirms that committed, and the ones left to the drain. */
export function followUpReadingOf({ day, mix }: TodayMix): OutcomeReading {
  const created = mix.outcomes.find((o) => o.outcome === "created")?.count ?? 0;
  return followUpReading(day, created, mix.followUpLeftToDrain);
}

/** The window, or null when there is none yet. THROWS on a read error. */
export async function loadFollowUpState(): Promise<RateWindowState | null> {
  const row = unwrap(
    await supabaseAdmin()
      .from("booking_failure_rate_state")
      .select("key, day, attempts, failures, by_code, refusals, samples")
      .eq("key", STATE_KEY)
      .maybeSingle(),
    "booking_failure_rate_state (booking_follow_up)",
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
 *  overlapping tick can never leave a second row ("assume it runs twice"). */
export async function saveFollowUpState(state: RateWindowState): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("booking_failure_rate_state")
    .upsert(
      {
        key: STATE_KEY,
        day: state.day,
        attempts: state.attempts,
        failures: state.failures,
        by_code: state.byCode,
        // Not used by this signal. Written as an empty object because the column is
        // NOT NULL and its default applies only on INSERT, so the second upsert
        // would fail without it (the reminder store's reason).
        refusals: {},
        samples: state.samples,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
  if (error) throw new Error(`booking_failure_rate_state (booking_follow_up) write failed: ${error.message}`);
}

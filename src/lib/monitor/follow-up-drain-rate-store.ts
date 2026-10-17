import type { RateWindowState, OutcomeReading } from "@/lib/monitor/booking-failure-rate";
import { followUpReading } from "@/lib/monitor/follow-up-drain-rate";
import type { TodayMix } from "@/lib/monitor/booking-failure-rate-store";
import { loadRateWindowRow, saveRateWindowRow } from "@/lib/monitor/rate-window-row";

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
 * next delta is taken against. The read and the write are `rate-window-row.ts`'s,
 * shared with the duplicate cancel share (#2377).
 */
const STATE_KEY = "booking_follow_up";

/** Today's counts as the window reads them, off the tally read the failure share
 *  already made: the confirms that committed, and the ones left to the drain. */
export function followUpReadingOf({ day, mix }: TodayMix): OutcomeReading {
  const created = mix.outcomes.find((o) => o.outcome === "created")?.count ?? 0;
  return followUpReading(day, created, mix.followUpLeftToDrain);
}

/** The window, or null when there is none yet. THROWS on a read error. */
export function loadFollowUpState(): Promise<RateWindowState | null> {
  return loadRateWindowRow(STATE_KEY);
}

/** Write the advanced window back. THROWS on a refused write. */
export function saveFollowUpState(state: RateWindowState): Promise<void> {
  return saveRateWindowRow(STATE_KEY, state);
}

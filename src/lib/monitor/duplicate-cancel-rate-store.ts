import type { RateWindowState, OutcomeReading } from "@/lib/monitor/booking-failure-rate";
import { duplicateCancelReading } from "@/lib/monitor/duplicate-cancel-rate";
import type { TodayMix } from "@/lib/monitor/booking-failure-rate-store";
import { loadRateWindowRow, saveRateWindowRow } from "@/lib/monitor/rate-window-row";

/**
 * The IO half of the duplicate cancel share (#2377): its reading off the tally read
 * the failure share already made, and its window in its own row of
 * `booking_failure_rate_state` (key `duplicate_cancel`), as the follow up drain and
 * reminder shares keep theirs. No migration: the row is the same shape.
 */
const STATE_KEY = "duplicate_cancel";

/** Today's duplicate cancel answers as the window reads them. */
export function duplicateCancelReadingOf({ day, mix }: TodayMix): OutcomeReading {
  return duplicateCancelReading(day, mix.duplicateCancel);
}

/** The window, or null when there is none yet. THROWS on a read error. */
export function loadDuplicateCancelState(): Promise<RateWindowState | null> {
  return loadRateWindowRow(STATE_KEY);
}

/** Write the advanced window back. THROWS on a refused write. */
export function saveDuplicateCancelState(state: RateWindowState): Promise<void> {
  return saveRateWindowRow(STATE_KEY, state);
}

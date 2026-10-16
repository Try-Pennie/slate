/**
 * Confirms whose follow up work was left to the reservation drain, counted and
 * paged on a RATE (#3267).
 *
 * Since #3263 a confirm whose work after the booking committed is cut off (by its
 * budget, or by a step that failed) still answers the booking, which is right: the
 * lead has a booking and must not be told to try again. The reservation is left
 * pending and the drain finishes the work on its next tick (`answerCommitted`).
 * Since #3514 most of that work is inside the one save, so what is left is mostly
 * the booking.created webhook to Regal (a step that failed or could not be built)
 * or the reservation's own delete.
 *
 * Until this it was a log line and nothing else. One such confirm is the drain
 * doing its job; a slow Supabase minute that cuts off a third of them is an outage
 * in the confirm path that every lead in it was answered through, and the only
 * thing that would have said so was the drain's stuck alert, and only if the drain
 * failed too. An outcome deliberately answered as a success still needs a volume
 * (L77), so it is counted against the confirms that committed and paged on a share.
 *
 * WHERE THE COUNT COMES FROM. The daily booking outcome tally (#418): the route
 * records `follow_up_left_to_drain` beside the `created` row of the same confirm, so
 * numerator and denominator come from one read of one table on one day boundary,
 * with the smoke canary and off site testers left out exactly as the failure rate
 * leaves them out. The name sits OUTSIDE `OUTCOME_ORDER`, so it never enters the
 * failure share's denominator (the race tally's trick). Only the create arm counts:
 * a cross bucket move also makes a booking, but its ordinary row is `rescheduled` or
 * `deduped`, never `created`, so counting it would put a numerator in the window
 * with no denominator behind it.
 *
 * THE WINDOW is the failure rate's own machinery (`advanceWindow`, a cumulative
 * daily counter differenced into five minute samples), kept in its own row of
 * `booking_failure_rate_state`, as the reminder lane keeps its window (#2496).
 *
 * THE NUMBERS, measured rather than typed (2026-10-16, production, read only):
 *  - The answerCommitted log line ("the booking committed and the work after it
 *    did not finish") appeared ZERO times in the seven days Workers Logs keeps,
 *    against 2,933 real bookings in the same week. So the healthy rate is zero, and
 *    anything that pages is far outside it.
 *  - Real bookings an hour over that week: 10th percentile 7, median 17, 90th
 *    percentile 28, highest 51 (169 hours with a booking).
 *  So the window is ONE hour, which the median hour fills well past the floor.
 *  The confirm floor (L716) is 10: below it the hour is unmeasured, which is the
 *  quietest sixth or so of hours, overnight. A page also needs at least 3 confirms
 *  left to the drain, so one or two unlucky saves never page however small the
 *  hour. Over the floor, a share above 10 percent pages: against a measured zero
 *  that is a cluster, not noise, and it is the shape of a slow minute cutting off
 *  several saves at once. Below the floor, a share of half or more still pages,
 *  because a floor that silences noise also silences a total failure (L139).
 *
 * THE ALL CLEAR hangs off a MEASURED clean run, never off the share dipping (#3275
 * found the window's share crossing the line both ways as old samples age out): the
 * last 30 minutes holding at least 5 confirms with no more than 5 percent of them
 * left to the drain. Too few confirms is not a clean run (L98, L695), so a quiet
 * half hour clears nothing. A page is sent only while that recent run is NOT clean,
 * so a burst that has measurably ended is not announced and cleared in one breath.
 *
 * No `@/` imports, so `scripts/test-follow-up-drain-rate.ts` (#3267) drives every branch
 * node natively; the reading, the state row and the sending are the caller's.
 */
import {
  advanceWindow,
  readRecent,
  windowTotals,
  type OutcomeReading,
  type RateWindowState,
  type Rebase,
} from "./booking-failure-rate.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** alert_state key for the page and its all clear. One constant for sender,
 *  catalog, preview and settings. */
export const FOLLOW_UP_DRAIN_ALERT_KEY = "booking_follow_up_left_to_drain";

/** #3267: the tally row a confirm adds when it answered the booking and left its follow up
 *  work to the drain. One constant for both routes, the reader and the tests. */
export const FOLLOW_UP_LEFT_TO_DRAIN_OUTCOME = "follow_up_left_to_drain";

export interface FollowUpThresholds {
  /** How far back the judged window reaches. */
  windowMs: number;
  /** Fewest committed confirms in the window before the share is judged (L716). */
  minConfirms: number;
  /** Fewest confirms left to the drain before anything pages, whatever the share. */
  minLeft: number;
  /** Share (percent) of committed confirms that must be EXCEEDED to page. */
  sharePct: number;
  /** At or above this share the confirm floor stops mattering (L139). */
  saturationPct: number;
  /** The recent run the all clear hangs off. */
  recent: { windowMs: number; minAttempts: number; recoverPct: number };
}

/** The shipped numbers; the module header says what they were measured against. */
export const FOLLOW_UP_DRAIN_THRESHOLDS: FollowUpThresholds = {
  windowMs: 60 * 60_000,
  minConfirms: 10,
  minLeft: 3,
  sharePct: 10,
  saturationPct: 50,
  recent: { windowMs: 30 * 60_000, minAttempts: 5, recoverPct: 5 },
};

/** Today's cumulative counts, as the window machinery reads them: the confirms that
 *  committed (`created`) and, of those, the ones that left work to the drain. */
export function followUpReading(day: string, created: number, leftToDrain: number): OutcomeReading {
  return { day, attempts: created, failures: leftToDrain, byCode: {} };
}

export type FollowUpVerdict =
  /** Too few confirms, and not saturated: measured nothing, so it pages nothing and clears nothing. */
  | { status: "insufficient"; confirms: number; left: number }
  /** Over the line by share or by saturation. */
  | { status: "breach"; confirms: number; left: number; pct: number; trigger: "rate" | "saturation" }
  /** Judged, and under the line. NOT by itself an all clear: that is the recent run's. */
  | { status: "under"; confirms: number; left: number; pct: number };

/** Judge the window as of `atMs`. The share is compared before rounding. */
export function judgeFollowUpDrain(state: RateWindowState, atMs: number, t: FollowUpThresholds): FollowUpVerdict {
  const { attempts: confirms, failures: left } = windowTotals(state, atMs, t.windowMs);
  const pct = confirms === 0 ? 0 : Math.round((left / confirms) * 100);
  const saturated = left >= t.minLeft && confirms > 0 && left * 100 >= t.saturationPct * confirms;
  if (confirms < t.minConfirms) {
    return saturated ? { status: "breach", confirms, left, pct, trigger: "saturation" } : { status: "insufficient", confirms, left };
  }
  if (left >= t.minLeft && left * 100 > t.sharePct * confirms) return { status: "breach", confirms, left, pct, trigger: "rate" };
  return { status: "under", confirms, left, pct };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The page. Built from measured counts only, so no error text can reach it. */
export function formatFollowUpDrainPage(v: { confirms: number; left: number; pct: number }, windowMinutes: number): string {
  return (
    `${v.left} of ${plural(v.confirms, "confirmed booking")} in the last ${windowMinutes} minutes (${v.pct}%) ` +
    `answered the lead before the work after the save had finished, so the reservation drain is finishing it. ` +
    `Those leads are booked; what waits is usually the booking.created webhook to Regal. ` +
    `Check that the drain is completing them (no reservation_drain_stuck page), then look for a slow ` +
    `Supabase in the confirm logs: "the booking committed and the work after it did not finish".`
  );
}

/** The all clear, from the recent run that measured it. */
export function formatFollowUpDrainAllClear(recent: { attempts: number; failures: number }, windowMinutes: number): string {
  const left = recent.failures === 0 ? "none" : `${recent.failures}`;
  return (
    `Confirms are finishing their own work after the save again: ${left} of the last ` +
    `${plural(recent.attempts, "confirmed booking")} in ${windowMinutes} minutes left work to the reservation drain.`
  );
}

export type FollowUpDrainResult =
  | { status: "rebased"; rebased: Exclude<Rebase, null> }
  | { status: "paged"; verdict: FollowUpVerdict }
  | { status: "cleared"; verdict: FollowUpVerdict; recent: { attempts: number; failures: number } }
  | { status: "held"; verdict: FollowUpVerdict; recent: { attempts: number; failures: number; completing: boolean } };

/**
 * One monitor tick. A read or a write that fails THROWS, so the step's own boundary
 * records it and nothing is paged or cleared off a measurement that was not made.
 */
export async function runFollowUpDrainCheck(deps: {
  nowMs: number;
  readToday: () => Promise<OutcomeReading>;
  loadState: () => Promise<RateWindowState | null>;
  saveState: (state: RateWindowState) => Promise<void>;
  thresholds: FollowUpThresholds;
  cooldownMs: number;
  notify: ThrottledNotify;
  resolve: AlertResolve;
}): Promise<FollowUpDrainResult> {
  const t = deps.thresholds;
  const reading = await deps.readToday();
  const prev = await deps.loadState();
  // The window keeps the longer of the two reaches, so the recent run can always be read from it.
  const keepMs = Math.max(t.windowMs, t.recent.windowMs);
  const { state, rebased } = advanceWindow(prev, reading, deps.nowMs, keepMs);
  await deps.saveState(state);
  // A rebase records no sample, so this tick measured no interval: it neither pages
  // nor clears, whatever the samples already held say (they were judged last tick).
  if (rebased !== null) return { status: "rebased", rebased };

  const verdict = judgeFollowUpDrain(state, deps.nowMs, t);
  const recent = readRecent(state, deps.nowMs, t.recent);
  const windowMinutes = Math.round(t.windowMs / 60_000);
  if (verdict.status === "breach" && !recent.completing) {
    await deps.notify(FOLLOW_UP_DRAIN_ALERT_KEY, deps.cooldownMs, formatFollowUpDrainPage(verdict, windowMinutes));
    return { status: "paged", verdict };
  }
  if (recent.completing) {
    await deps.resolve(
      FOLLOW_UP_DRAIN_ALERT_KEY,
      formatFollowUpDrainAllClear(recent, Math.round(t.recent.windowMs / 60_000)),
    );
    return { status: "cleared", verdict, recent };
  }
  return { status: "held", verdict, recent };
}

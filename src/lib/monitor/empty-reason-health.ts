import { explainEmptyWindow, type EmptyWindowInputs } from "@/lib/availability/empty-reason";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/**
 * Watching whether the booker can still say WHY a week is empty (#1420).
 *
 * #1414 gave the booker a third empty-window state: the server returned a window
 * with no times and did not say why, so the lead reads "We could not work out what
 * is available right now" with a retry. That degrades honestly, which is the point
 * of it, and that honesty is exactly what kept the fault invisible: nothing paged,
 * nothing recorded a verdict, and the funnel just got quieter. An unclassifiable
 * window and a genuinely quiet day are the same silence from the inside.
 *
 * **Why this is measured on the LANE and not on the availability read.** The
 * cheapest place to count it is the request that produced it, and that would have
 * been wrong: it can only ever conclude when a lead is present, and before cutover
 * there are none. The detector would have shipped blind, stayed blind, and looked
 * exactly like one finding nothing wrong, which is the shape #1394 was filed about
 * and which the availability truth probe had already been caught doing for real.
 *
 * The classifier needs two things, the org's business hours and the booking
 * horizon, and the monitor lane already holds both on every pass. So it asks the
 * REAL classifier the same question, with no traffic at all, and reaches a
 * measured verdict on every tick.
 *
 * **Deliberately NOT gated by `monitorSetupGates`.** Every other consumer of those
 * two reads skips when they fail, because judging with a guessed week or a guessed
 * horizon is worse than not judging. Here the reads ARE the subject: an unreadable
 * week is not a reason to sit the check out, it is the finding. A gate would make
 * this check silent in precisely the state it exists to notice.
 *
 * **It does not double notify with #1412.** That one pages when a TIER is offering
 * no times; this one never looks at a tier's slot count and cannot tell you
 * anything about supply. They also cannot overlap in practice: the availability
 * scan #1412 rides on is gated on the business-hours read, so the tick where this
 * check fires is a tick where that one has already stood down.
 *
 * Pure apart from the injected IO, so the whole decision is node-tested
 * (scripts/test-monitor-empty-reason.ts).
 */

/** alert_state row key for the page and its all-clear. Lives with the feature so
 *  the cron and the settings screen refer to the one constant. */
export const BOOKER_EMPTY_REASON_KEY = "booker_empty_reason";

/**
 * The consecutive-tick counter, a SEPARATE key from the alert above.
 *
 * One throttles the counting and the other throttles the sending. Sharing them
 * would mean clearing the streak on a healthy tick also cleared the page, so the
 * condition could never be reported as still standing.
 */
export const EMPTY_REASON_STREAK_KEY = "streak:booker_empty_reason";

/**
 * How long a tick counts towards the streak.
 *
 * Comfortably longer than the monitor lane's FIVE minute interval, so two
 * genuinely consecutive ticks land in the same window rather than each looking
 * like the first, which would mean the second never reached the threshold and the
 * page could never fire at all. Fifteen minutes leaves room for a late tick
 * without stretching the time to page beyond ten minutes or so.
 */
export const EMPTY_REASON_STREAK_WINDOW_S = 900;

export type EmptyReasonVerdict =
  /** The classifier reached a reason from the config as it stands. */
  | { status: "explains" }
  /** It could not, and this is what stopped it. */
  | { status: "blind"; why: string; paged: boolean };

/**
 * The page. It leads with what the LEAD is not being told, because that is the
 * cost of the fault and the reason it is worth waking up for; the blocker follows,
 * because that is what the reader acts on.
 *
 * The blocker is a phrase this module built, never a raw error, so a page cannot
 * arrive as a wall of database JSON cut off mid-word (#1133).
 */
export function formatEmptyReasonAlert(blockedBy: string): string {
  return (
    `A lead who finds no times is being told we could not work out what is available, ` +
    `instead of whether we are closed or fully booked, because ${blockedBy}. ` +
    `The business hours and the booking horizon are both on the admin settings screen.`
  );
}

/** The all-clear. It answers the page's claim directly: the lead is being told
 *  which of the two it is again. */
export function formatEmptyReasonRecovery(): string {
  return (
    `The booker can say why a week is empty again: it read the org's business hours ` +
    `and the booking horizon on this check, so a lead who finds no times is told ` +
    `whether we are closed or fully booked. No action is needed.`
  );
}

/**
 * The monitor-cron step: ask the real classifier, page on a PERSISTENT failure,
 * and clear only off a measured healthy reading.
 *
 * The first unreadable tick stays quiet: one failed read is an ordinary database
 * blip, and paging on it is the alert that cries wolf (L36). The second
 * consecutive one pages, which on a five minute lane is about ten minutes after
 * the config went unreadable. A tick that could not read its signal also clears
 * NOTHING, in either direction (#1152): it measured no health, so it may not claim
 * any.
 *
 * A notify or resolve failure is swallowed. A flaky Slack must never fail the
 * monitor tick or take out the checks after it.
 */
export async function runEmptyReasonCheck(deps: {
  inputs: EmptyWindowInputs;
  /** True once the blind state has persisted for enough consecutive ticks. */
  streak: () => Promise<boolean>;
  clearStreak: () => Promise<void>;
  notify: ThrottledNotify;
  /** REQUIRED, so `tsc` enumerates every construction site rather than letting a
   *  caller wire a condition with no way to end it (#1151, #1400). */
  resolve: AlertResolve;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<EmptyReasonVerdict> {
  const outcome = explainEmptyWindow(deps.inputs);
  if (outcome.reason === null) {
    const persistent = await deps.streak();
    if (persistent) {
      await deps
        .notify(BOOKER_EMPTY_REASON_KEY, deps.cooldownMs, formatEmptyReasonAlert(outcome.blockedBy))
        .catch(() => {});
    }
    deps.log?.(
      `monitor empty-reason: the booker cannot explain an empty week (${outcome.blockedBy})` +
        (persistent ? "; paged" : "; first tick, staying quiet"),
    );
    return { status: "blind", why: outcome.blockedBy, paged: persistent };
  }
  // A MEASURED healthy reading: the real classifier reached a reason from the real
  // config on this tick. Not "we did not alert this run", which is the thing #1134
  // and #1152 were both filed about.
  await deps.clearStreak();
  await deps.resolve(BOOKER_EMPTY_REASON_KEY, formatEmptyReasonRecovery()).catch(() => {});
  return { status: "explains" };
}

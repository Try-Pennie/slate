/**
 * The shared confirm line was switched on, and has been left OFF (#3339).
 *
 * The shared confirm line (#3325) is `booking_settings.shared_confirm_line`, flipped on
 * the admin Hours page with no deploy. Once it is on, turning it off is the lever for
 * containing a problem with the line, and the ordinary failure is the one #2366 found
 * for the booking kill switch: the problem is fixed and nobody flips it back. Every
 * server then keeps its own line for confirms again, and nothing says so until a crowd
 * for one time saturates the database, as in load run 37333201026, while every other
 * signal reads healthy (L523: a hand set suppression needs visibility).
 *
 * ## Off is not a finding until the line has been switched on
 *
 * Production has never had it on. Until somebody has, off is the expected state, so the
 * check needs to know WHETHER and WHEN the line was activated. That is read from the
 * audit trail the admin action already writes on every flip (`booking.settings` with
 * `{ shared_confirm_line: true | false }`), which is immutable (migration 0089), rather
 * than from a new column: the record exists, and a column would be a second home for
 * the same fact (L83).
 *
 * The clock runs from the FIRST time it was turned off after the newest time it was
 * turned on, never from the newest off: pressing off twice must not restart it, the
 * reason migration 0132 stamps the kill switch at the transition. A switch read off with
 * no recorded off after its last on (hand SQL, or an audit write that failed) has no
 * clock, and the last time it was turned on bounds how long it can have been off: under a
 * day since then it cannot have stood a day, and past it, it speaks without a span.
 *
 * ## It is a condition, and it is not a fault
 *
 * A condition, because it stays true until a person turns the line back on, so it
 * carries an all clear hung off a tick that READ the switch as on, never off a tick that
 * said nothing (#1134, #1152). Not a fault, because somebody turned it off on purpose:
 * the notice asks whether it is still meant to be off. There is no automatic re-enable,
 * for the reason the kill switch has none: a lever that lifted itself would undo the
 * containment it was pulled for.
 *
 * A failed read never reaches here: the loader throws and the step boundary reports it
 * under `monitor_step_failing`, which carries its own all clear.
 *
 * Pure: no `@/` imports and no clock of its own, so the node suite drives every branch.
 */
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import { describeGap } from "./health.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** alert_state row key for the notice and its all clear. */
export const SHARED_LINE_LEFT_OFF_KEY = "shared_confirm_line_left_off";

/**
 * How long the line may stand switched off after activation before anybody is asked
 * about it: a day, Dan's own number on #3339 ("page when it has been off for more than a
 * day after activation"). Far longer than containing a line problem takes, and short
 * enough that a forgotten switch is asked about the next working day.
 *
 * Wall clock from the moment it was turned off; the org's hours decide only when the
 * question is SPOKEN, as for the kill switch.
 */
export const SHARED_LINE_OFF_NOTICE_AFTER_MS = 24 * 60 * 60_000;

/** What the switch and its audit trail say right now. */
export interface SharedLineSwitchHistory {
  /** The stored switch. */
  on: boolean;
  /** Epoch ms an admin last turned it on, or null when nobody ever has (only read while it is off). */
  lastOnAtMs: number | null;
  /** Epoch ms it was first turned off after that, or null when nothing recorded it. */
  offSinceMs: number | null;
}

export type LeftOffAction =
  /** Measured on. The only thing that may end the notice. */
  | { act: "clear" }
  /** Off, and never once turned on: the expected state, about which there is nothing to say. */
  | { act: "dormant" }
  /** Off for long enough after activation, and now is a reasonable moment to say so. */
  | { act: "speak"; elapsedMs: number | null }
  /** Off, and nothing said this tick. `why` is what the lane logs. */
  | { act: "hold"; why: string; elapsedMs: number | null };

/**
 * What to do about one reading. `open` is whether the org is inside its advertised hours,
 * or null when the week could not be read, which errs toward speaking: the fact reported
 * is fully measured and only the courtesy of a civil hour is unknown.
 */
export function sharedLineLeftOffAction(input: {
  reading: SharedLineSwitchHistory;
  nowMs: number;
  open: boolean | null;
  thresholdMs: number;
}): LeftOffAction {
  const { reading, nowMs, open, thresholdMs } = input;
  if (reading.on) return { act: "clear" };
  if (reading.lastOnAtMs === null) return { act: "dormant" };

  // Clamped at zero: a stamp ahead of the reader's clock is skew between two machines.
  const elapsedMs = reading.offSinceMs === null ? null : Math.max(0, nowMs - reading.offSinceMs);
  if (elapsedMs !== null && elapsedMs < thresholdMs) {
    return { act: "hold", why: `switched off ${describeGap(elapsedMs)} ago, inside the day the lever may be held for`, elapsedMs };
  }
  // No recorded off: it has been off for at most the time since it was last turned on.
  if (elapsedMs === null && nowMs - reading.lastOnAtMs < thresholdMs) {
    return {
      act: "hold",
      why: `switched off with nothing recording when, and it was switched on only ${describeGap(Math.max(0, nowMs - reading.lastOnAtMs))} ago, so it cannot have stood a day`,
      elapsedMs,
    };
  }
  if (open === false) {
    return { act: "hold", why: "outside the hours the org advertises, so the question waits for the day to start", elapsedMs };
  }
  return { act: "speak", elapsedMs };
}

// --------------------------------------------------------------- the copy

/**
 * The notice: how long, that somebody chose it, what it costs, and the one place it is
 * switched back on.
 */
export function formatSharedLineLeftOffAlert(elapsedMs: number | null): string {
  const opener =
    elapsedMs === null
      ? "The shared confirm line is switched off, and nothing recorded when it was turned off, only that it was switched on more than a day ago."
      : `The shared confirm line has been switched off for ${describeGap(elapsedMs)}, after it had been switched on.`;
  return (
    `${opener} Somebody turned it off on purpose, so this is a question rather than a fault: is it still meant ` +
    `to be off? While it is off, each server keeps its own line for confirms, so a crowd of leads asking for the ` +
    `same time can swamp the database and be told to try again, which is what the shared line was switched on ` +
    `to stop. Switch it back on from the admin business hours page, or leave it and this will ask again while it stands.`
  );
}

/** The all clear. It answers the notice's own claim directly. */
export function formatSharedLineBackOnRecovery(): string {
  return (
    "The shared confirm line is switched on again, so confirms for one time wait in one line across every " +
    "server, and the earlier notice about it being left off is cleared. No action is needed."
  );
}

// ------------------------------------------------------------- the runner

export type SharedLineLeftOffVerdict =
  /** Measured: the line is on. */
  | { status: "on" }
  /** Measured: off, and nobody has ever turned it on. */
  | { status: "never-activated" }
  /** Measured: off after activation. `spoke` is false when nothing was sent. */
  | { status: "off"; elapsedMs: number | null; spoke: boolean; why: string }
  /** The step boundary's fallback for a tick whose read threw; never produced here. */
  | { status: "unreadable" };

export const SHARED_LINE_LEFT_OFF_UNREADABLE: SharedLineLeftOffVerdict = { status: "unreadable" };

/**
 * The monitor cron step: read the switch and its history, speak when it has been left off
 * too long, and clear ONLY off a measured on. No consecutive tick streak: stored
 * configuration changes when a person edits it and never flickers.
 *
 * A notify or resolve failure is swallowed after the verdict is decided, so a flaky Slack
 * never fails the tick and the check never reports that it spoke when it did not.
 */
export async function runSharedLineLeftOffCheck(deps: {
  reading: SharedLineSwitchHistory;
  nowMs: number;
  open: boolean | null;
  thresholdMs: number;
  notify: ThrottledNotify<unknown>;
  /** REQUIRED, so `tsc` names every construction site (#1151, #1400). */
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<SharedLineLeftOffVerdict> {
  const action = sharedLineLeftOffAction(deps);

  if (action.act === "clear") {
    await deps.resolve(SHARED_LINE_LEFT_OFF_KEY, formatSharedLineBackOnRecovery()).catch(logResolveFailure(SHARED_LINE_LEFT_OFF_KEY));
    return { status: "on" };
  }
  // Nothing could have paged, and nothing healthy was measured, so nothing is cleared:
  // the all clear is reserved for a switch read on.
  if (action.act === "dormant") return { status: "never-activated" };

  if (action.act === "speak") {
    await deps
      .notify(SHARED_LINE_LEFT_OFF_KEY, deps.cooldownMs, formatSharedLineLeftOffAlert(action.elapsedMs))
      .catch(logAlertSendFailure(SHARED_LINE_LEFT_OFF_KEY));
    const why = action.elapsedMs === null ? "off after activation, with nothing recording when" : `off for ${describeGap(action.elapsedMs)}`;
    deps.log?.(`monitor shared-line-left-off: ${why}; said so`);
    return { status: "off", elapsedMs: action.elapsedMs, spoke: true, why };
  }

  deps.log?.(`monitor shared-line-left-off: ${action.why}; said nothing`);
  return { status: "off", elapsedMs: action.elapsedMs, spoke: false, why: action.why };
}

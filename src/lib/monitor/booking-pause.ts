/**
 * Public booking has been STOPPED and left that way (#2366).
 *
 * #2297 gave Slate a kill switch and made it visible: the admin Overview carries a
 * row saying whether public booking is running or stopped. That helps somebody who
 * looks. Nothing raises a hand at somebody who does not.
 *
 * The failure is ordinary and quiet. Somebody stops bookings at 2am to contain a
 * problem, fixes the problem, and does not flip it back. Slate then takes zero
 * bookings while every other signal reads healthy, because everything else IS
 * healthy: availability computes, calendars sync, the lanes are alive. What
 * eventually notices is the low booking volume alarm, and it reports a DROUGHT,
 * which sends a reader to the funnel, the embed and the availability cache, none of
 * which is wrong.
 *
 * ## It is a condition, and it is not a fault
 *
 * A condition, because it stays true until a person turns booking back on, and
 * whoever read the notice needs to know when that happened. So it carries an all
 * clear, hung off a tick that READ the flag and found it false, never off a tick
 * that merely did not speak (#1134, #1152).
 *
 * Not a fault, because somebody pulled that switch on purpose. The message says how
 * long it has stood and asks whether it is still meant to be off. There is no auto
 * unpause and there should not be: a switch that lifted itself would start taking
 * bookings again in the middle of the incident it was thrown for, which is worse
 * than being forgotten. L523 asks for an expiry AND visibility on a hand set
 * suppression; visibility is the half that helps here, and this is it.
 *
 * ## Where the clock comes from
 *
 * From `booking_settings.public_booking_paused_at`, stamped by the database trigger
 * in migration 0132 at the moment the flag goes from running to stopped, and NEVER
 * from when the monitor first noticed. A deploy or a lane restart would otherwise
 * reset the count and the notice would never fire. It is not `updated_at`, which is
 * shared with the other columns on that single settings row, so editing the booking
 * horizon would push the pause clock forward.
 *
 * The trigger, rather than the admin action, owns the stamp for two reasons. The
 * control posts the STATE it wants rather than toggling, so pressing stop twice
 * would restart the clock if the writer set it unconditionally; and the flag is also
 * written by `pnpm verify:kill-switch` and by hand SQL, neither of which would
 * remember. One writer at the layer every path shares (L593).
 *
 * ## How long is too long
 *
 * `PAUSE_NOTICE_AFTER_MS`, and it is derived rather than chosen. See its own comment.
 *
 * Pure: no `@/` imports and no clock of its own, so the node suite drives every
 * branch directly.
 */
import { describeGap } from "./health.ts";
import { LOW_VOLUME_WINDOW_MINUTES } from "./booking-volume.ts";

/** alert_state row key for the notice and its all clear. Lives with the feature so
 *  the cron and the settings screen refer to the one constant. */
export const PUBLIC_BOOKING_STOPPED_KEY = "public_booking_stopped";

/**
 * How long public booking may be stopped before anybody is told, and why this
 * number rather than a preference.
 *
 * It is the LONGEST window Slate already treats as long enough to say something
 * about bookings not happening: the low booking volume alarm's long window. Below
 * that mark the product itself does not consider a quiet stretch worth a word, so a
 * notice firing sooner would be calling a stretch too long while the alarm beside it
 * called the same stretch ordinary. At that mark the two arrive together, and this
 * one names the cause the volume alarm structurally cannot see: it reports that
 * nobody booked, and cannot report that nobody was allowed to.
 *
 * Read from that constant rather than restated here, so moving one moves the other
 * (L41, L401). It is also far longer than the minutes the lever is meant to be held
 * for, so containing an incident never trips it, and short enough to land inside the
 * same working day rather than after a day of leads.
 *
 * The span is WALL CLOCK from the moment the switch was set. It is not counted in
 * open hours, and that is the deliberate choice: counting only advertised time would
 * delay the morning notice about a 2am pause by the whole threshold, which is the
 * exact case this exists for. What the org's hours decide is when the notice is
 * SPOKEN, never whether there is something to say.
 */
export const PAUSE_NOTICE_AFTER_MS = LOW_VOLUME_WINDOW_MINUTES.long * 60_000;

/** What the settings row says about the switch right now. */
export interface BookingPauseReading {
  paused: boolean;
  /**
   * Epoch ms the switch was last set to stopped, or null when nothing recorded it.
   *
   * Null is a real state rather than a read failure: a row paused by hand SQL
   * against a database without the trigger carries no stamp, and a read that FAILED
   * never reaches here at all (the loader throws and the step boundary reports it).
   */
  sinceMs: number | null;
}

export type PauseAction =
  /** Measured running. The only thing that may end the notice. */
  | { act: "clear" }
  /** Stopped, long enough, and now is a reasonable moment to say so. */
  | { act: "speak"; elapsedMs: number | null }
  /** Stopped, and nothing said this tick. `why` is what the lane logs. */
  | { act: "hold"; why: string; elapsedMs: number | null };

/**
 * What to do about one reading.
 *
 * `open` is whether the org is inside its advertised hours right now, or null when
 * the week could not be read. An unreadable week errs toward SPEAKING: the fact
 * being reported is fully measured (bookings have been stopped for longer than the
 * threshold) and only the courtesy of picking a civil hour is unknown, where staying
 * silent for days is the failure this check exists to end.
 */
export function bookingPauseAction(input: {
  reading: BookingPauseReading;
  nowMs: number;
  open: boolean | null;
  thresholdMs: number;
}): PauseAction {
  const { reading, nowMs, open, thresholdMs } = input;
  if (!reading.paused) return { act: "clear" };

  // Clamped at zero: a stamp ahead of the reader's clock is skew between two
  // machines, and rendering it as a negative age would put a nonsense span in front
  // of somebody mid incident.
  const elapsedMs = reading.sinceMs === null ? null : Math.max(0, nowMs - reading.sinceMs);

  if (elapsedMs !== null && elapsedMs < thresholdMs) {
    return {
      act: "hold",
      why: `stopped ${describeGap(elapsedMs)} ago, which is inside the window the lever is meant to be used in`,
      elapsedMs,
    };
  }

  // Past the threshold, or stopped with no recorded start. The second cannot be
  // waited out, because there is no clock to wait: silence about it would be the
  // same silence this check exists to end.
  if (open === false) {
    return {
      act: "hold",
      why: "outside the hours the org advertises, so nobody is being turned away and nobody can act on it yet",
      elapsedMs,
    };
  }
  return { act: "speak", elapsedMs };
}

// --------------------------------------------------------------- the copy

/**
 * The notice.
 *
 * It opens with the fact the reader has nowhere else (how long), says plainly that
 * somebody chose this so it does not read as a defect, names what it is costing,
 * names the alarm that would otherwise report the same silence as a drought, and
 * ends with the one place the switch is flipped back.
 */
export function formatPublicBookingStoppedAlert(elapsedMs: number | null): string {
  const opener =
    elapsedMs === null
      ? "Online booking is stopped, and nothing recorded when it was stopped, so how long it has stood cannot be said."
      : `Online booking has been stopped for ${describeGap(elapsedMs)}.`;
  return (
    `${opener} Somebody turned it off on purpose, so this is a question rather than a ` +
    `fault: is it still meant to be off? While it stands, a lead who reaches the booker ` +
    `is told no time can be taken, and the low booking volume alarm reports that as a ` +
    `drought, which sends whoever reads it after a funnel problem that is not there. ` +
    `Start it again on the admin business hours page, or leave it and this will ask ` +
    `again while it stands.`
  );
}

/** The all clear. It answers the notice's own claim directly. */
export function formatPublicBookingRunningRecovery(): string {
  return (
    `Online booking is running again, so a lead reaching the booker can take a time and ` +
    `the earlier notice about it being stopped is cleared. No action is needed.`
  );
}

// ------------------------------------------------------------- the runner

export type BookingPauseVerdict =
  /** Measured: the switch is off and bookings are being taken. */
  | { status: "running" }
  /** Measured: bookings are stopped. `spoke` is false when nothing was sent. */
  | { status: "stopped"; elapsedMs: number | null; spoke: boolean; why: string }
  /**
   * The declared fallback for a tick whose read THREW, so the lane's response and
   * logs tell a run that could not measure apart from one that measured and found
   * the switch on. It is never produced here: the loader throws and the step
   * boundary hands this back, which is also what pages `monitor_step_failing`.
   */
  | { status: "unreadable" };

export const BOOKING_PAUSE_UNREADABLE: BookingPauseVerdict = { status: "unreadable" };

/**
 * The monitor cron step: read the switch, speak when it has stood too long, and
 * clear ONLY off a measured running switch.
 *
 * No consecutive tick streak, unlike the checks that watch a READ: this watches
 * stored configuration, which changes when a person edits it and never flickers, so
 * a first tick reporting it stopped is already the standing truth. Same reasoning as
 * `roster-coverage.ts` next door.
 *
 * A notify or resolve failure is swallowed, because a flaky Slack must never fail
 * the tick or take out the checks after it. It is swallowed AFTER the verdict is
 * decided, so the check never reports that it spoke when it did not.
 */
export async function runBookingPauseCheck(deps: {
  reading: BookingPauseReading;
  nowMs: number;
  /** Whether the org is open right now, or null when the week could not be read. */
  open: boolean | null;
  thresholdMs: number;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  /** REQUIRED, so `tsc` enumerates every construction site rather than letting a
   *  caller wire a condition with no way to end it (#1151, #1400). */
  resolve: (key: string, text: string) => Promise<boolean>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<BookingPauseVerdict> {
  const action = bookingPauseAction({
    reading: deps.reading,
    nowMs: deps.nowMs,
    open: deps.open,
    thresholdMs: deps.thresholdMs,
  });

  if (action.act === "clear") {
    await deps
      .resolve(PUBLIC_BOOKING_STOPPED_KEY, formatPublicBookingRunningRecovery())
      .catch(() => {});
    return { status: "running" };
  }

  if (action.act === "speak") {
    await deps
      .notify(
        PUBLIC_BOOKING_STOPPED_KEY,
        deps.cooldownMs,
        formatPublicBookingStoppedAlert(action.elapsedMs),
      )
      .catch(() => {});
    const why =
      action.elapsedMs === null
        ? "stopped, with nothing recording when"
        : `stopped for ${describeGap(action.elapsedMs)}`;
    deps.log?.(`monitor booking-pause: ${why}; said so`);
    return { status: "stopped", elapsedMs: action.elapsedMs, spoke: true, why };
  }

  deps.log?.(`monitor booking-pause: ${action.why}; said nothing`);
  return { status: "stopped", elapsedMs: action.elapsedMs, spoke: false, why: action.why };
}

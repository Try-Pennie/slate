/**
 * May the nightly kill switch drill pause public booking at this instant? (#3920)
 *
 * The drill (`pnpm verify:kill-switch`, scheduled by `.github/workflows/kill-switch.yml`)
 * stops public booking for about two seconds, so its cron sits in the small hours. A
 * cron's declared time is not when it runs (L386): GitHub started it 4.5 to 9.5 hours
 * late on every one of its runs for a month, between 7:32 AM and 12:40 PM Eastern, so it
 * paused live booking inside business hours every morning. On 2026-10-19 the booking
 * route answered two requests at 10:35 AM Eastern with "bookings are paused". Nothing the
 * workflow can declare prevents that, so the command asks the clock itself, against the
 * org's own hours, before it writes anything.
 *
 * THE RULE. The drill may pause only when now is outside every open window the org has,
 * widened by `DRILL_MARGIN_MINUTES` before it opens and after it closes, judged on the
 * org's wall clock in the org's zone. "Open" is decided by `windowOnDate`, the single
 * judge of whether the org is open on a date (L107), so closed dates and dates opened by
 * an exception count exactly as they do for the booker. Yesterday and tomorrow are asked
 * as well as today, because a window touching midnight carries its margin across the
 * date boundary.
 *
 * FAIL SAFE TOWARD NOT PAUSING. Hours that cannot be read, a zone the clock cannot be
 * read in, and an unreadable clock all answer `hours-unreadable`, never `clear`: the
 * cost of a skipped night is one missing verdict, which the staleness bound reports, and
 * the cost of a wrong `clear` is refusing real leads.
 *
 * Pure: no IO and no clock read. The command reads the hours and the time and hands
 * them in, which is what lets `scripts/test-kill-switch-clock.ts` drive every edge.
 */
import { DateTime } from "luxon";
import {
  windowOnDate,
  BUSINESS_ZONE,
  type BusinessHoursException,
  type BusinessWindow,
} from "../../src/lib/booking/business-hours.ts";
import { KILL_SWITCH_EXIT } from "./kill-switch-live-control.ts";

/**
 * How far either side of the open window the drill also stands down.
 *
 * Thirty minutes, chosen to be comfortably larger than everything that can separate the
 * clock check from the pause: the probe and availability read before the write take
 * seconds, and the job's whole `timeout-minutes` is ten, so even a run that stalled
 * between the check and the write could not reach the advertised window. It also covers
 * the shoulders of the day, the leads booking just before the office opens and just after
 * it closes. And it costs almost nothing: on the seeded week the night left to the drill
 * is still eleven hours long (20:30 to 07:30).
 */
export const DRILL_MARGIN_MINUTES = 30;

/** The org's hours as the command read them, or why they could not be read. */
export type OrgHoursReading =
  | {
      ok: true;
      hours: { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] };
    }
  | { ok: false; reason: string };

export type DrillClockDecision =
  /** Outside every open window and its margin: the drill may pause. */
  | { kind: "clear"; detail: string }
  /** Inside an open window or its margin: stand down without pausing. */
  | { kind: "inside-hours"; detail: string }
  /** The hours or the clock could not be read: stand down without pausing. */
  | { kind: "hours-unreadable"; detail: string };

const MIN_MS = 60_000;
const LEFT_ALONE = "Public booking was not paused, and nothing was measured about the kill switch.";

/** A wall clock minute on a local day, as an instant. 1440 is the next local midnight. */
function minuteOnDay(day: DateTime, minutes: number): DateTime {
  if (minutes >= 1440) return day.plus({ days: 1 }).startOf("day");
  return day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });
}

/** "9:14 AM EDT on Monday, October 19": the org's own clock, named with its offset. */
function spoken(instant: DateTime): string {
  return `${instant.toFormat("h:mm a ZZZZ")} on ${instant.toFormat("cccc, LLLL d")}`;
}

function unreadable(reason: string): DrillClockDecision {
  return {
    kind: "hours-unreadable",
    detail:
      `The org's business hours could not be checked (${reason}), so whether pausing booking ` +
      `now would turn away real leads was not known. ${LEFT_ALONE}`,
  };
}

/**
 * Judge `nowMs` against the org's hours. See the file header for the rule and why each
 * failure direction is the one it is.
 */
export function judgeDrillClock(
  reading: OrgHoursReading,
  nowMs: number,
  marginMinutes: number = DRILL_MARGIN_MINUTES,
): DrillClockDecision {
  if (!reading.ok) return unreadable(reading.reason);
  if (!Number.isFinite(nowMs)) return unreadable("the runner's clock could not be read");
  const { hours } = reading;
  const now = DateTime.fromMillis(nowMs, { zone: hours.zone });
  if (!now.isValid) return unreadable(`the zone ${hours.zone} could not be read`);

  const today = now.startOf("day");
  for (const offset of [-1, 0, 1]) {
    const day = today.plus({ days: offset });
    const isoDate = day.toISODate();
    if (isoDate === null) return unreadable(`the date in ${hours.zone} could not be read`);
    const window = windowOnDate(hours, isoDate, day.weekday);
    if (!window) continue;
    const opens = minuteOnDay(day, window.start_minute);
    const closes = minuteOnDay(day, window.end_minute);
    const from = opens.toMillis() - marginMinutes * MIN_MS;
    const until = closes.toMillis() + marginMinutes * MIN_MS;
    if (nowMs >= from && nowMs < until) {
      return {
        kind: "inside-hours",
        detail:
          `This run reached its clock check at ${spoken(now)}, inside the org's hours that day ` +
          `(${opens.toFormat("h:mm a")} to ${closes.toFormat("h:mm a")}) or within ` +
          `${marginMinutes} minutes of them, so the drill stood down. ${LEFT_ALONE}`,
      };
    }
  }
  return {
    kind: "clear",
    detail:
      `It is ${spoken(now)}, outside the org's hours and more than ${marginMinutes} minutes ` +
      `from them, so the drill may pause public booking.`,
  };
}

/** The exit a clock decision ends the run on, or null when the drill goes on. */
export function drillClockExit(decision: DrillClockDecision): number | null {
  if (decision.kind === "inside-hours") return KILL_SWITCH_EXIT.insideBusinessHours;
  if (decision.kind === "hours-unreadable") return KILL_SWITCH_EXIT.hoursUnreadable;
  return null;
}

/** The line the command writes to the job summary, so the Actions page says it too. */
export function drillClockSummaryLine(decision: DrillClockDecision): string {
  if (decision.kind === "inside-hours") return `**Kill switch proof skipped: inside business hours.** ${decision.detail}`;
  if (decision.kind === "hours-unreadable") return `**Kill switch proof did not run: business hours could not be checked.** ${decision.detail}`;
  return `Clock checked before pausing: ${decision.detail}`;
}

/**
 * The earliest date whose exception the judgement can consult: yesterday in the org's
 * zone, because a window closing at midnight carries its margin into today. Null when
 * the clock cannot be read, rather than a guessed date.
 */
export function exceptionsConsultedFrom(nowMs: number, zone: string = BUSINESS_ZONE): string | null {
  if (!Number.isFinite(nowMs)) return null;
  const now = DateTime.fromMillis(nowMs, { zone });
  if (!now.isValid) return null;
  return now.startOf("day").minus({ days: 1 }).toISODate();
}

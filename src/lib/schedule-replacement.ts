/**
 * What replacing a user's weekly hours should write, or why it must be refused
 * (#1293). Pure, no `@/` imports, so it runs node-native (luxon is a package, and
 * `IANAZone.isValidZone` is the repo's existing zone validator).
 *
 * The write path deletes every rule for the schedule and reinserts, so a REFUSED
 * input is not a cosmetic validation matter: clearing the rules removes that agent
 * from every bucket's availability, silently, while the form reports a successful
 * save. So an input that cannot produce a real week is refused before anything is
 * deleted, with a message aimed at the person who pressed save.
 *
 * The empty-week message names both routes that DO exist, because someone clearing
 * their week wants one of them and a refusal that only says no is a dead end:
 * approved time off keeps them out of availability for a dated absence (it writes an
 * event their calendar makes busy), and `users.bookable` is the roster-level switch
 * for anything longer. Both leave a trace an admin can see, which an empty schedule
 * does not.
 *
 * Minutes are from local midnight, and 1440 (midnight at the end of the day) is a
 * legitimate end bound the compute already handles, so the range is inclusive there.
 * Weekdays follow Luxon (1 = Monday .. 7 = Sunday), so 0 would silently match no day.
 */

import { IANAZone } from "luxon";

export interface ScheduleRule {
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export type ScheduleReplacementPlan =
  | { ok: true; rules: ScheduleRule[]; timezone: string }
  | { ok: false; error: string };

const DAY_END_MINUTE = 1440;

const isWholeNumber = (n: number): boolean => Number.isInteger(n);

/** The name a refusal calls a weekday, so "Friday ends before it starts" reads as
 *  an instruction rather than as an index. */
const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Plan the replacement from a window PER DAY (#1308).
 *
 * The week used to be one start and one end applied to every checked day, which an
 * agent working 8 to 4 on Fridays simply could not express. Worse, the engine has
 * always honoured a window per weekday (`isWithinWorkingHours` loops every rule
 * matching the day), so per-day hours written by any other route were displayed as
 * the first day's values and then overwritten on the next save, silently.
 *
 * Every day is validated on its own terms and the refusal NAMES the day, because a
 * seven row form that answers "those times could not be read" tells the person
 * nothing about which row to look at. All or nothing still: one bad day refuses the
 * whole save, since a partial write would leave a week nobody chose while reporting
 * success.
 */
export function planScheduleReplacement(
  days: ScheduleRule[],
  /**
   * The zone the week is expressed in. REQUIRED, so `tsc` names every write path
   * rather than letting one skip the check (#1671).
   *
   * It is not cosmetic. `isWithinWorkingHours` compares `rule.weekday !== day.weekday`,
   * and a zone Luxon cannot read makes `day.weekday` NaN, so every comparison is
   * false, every rule misses, and the agent is bookable at NO time at all. The
   * column is `text not null` with no CHECK and a CHECK cannot call the timezone
   * catalog (it is not immutable), so this validated write path is what keeps a
   * predicate-breaking value out of it (L150).
   */
  timezone: string,
): ScheduleReplacementPlan {
  if (!IANAZone.isValidZone(timezone)) {
    return {
      ok: false,
      error:
        `"${timezone}" is not a timezone we can read, so your hours were not saved. ` +
        `Pick one from the list, for example America/New_York.`,
    };
  }
  if (days.length === 0) {
    return {
      ok: false,
      error: "Pick at least one day you are available. If you are away, submit a time off request instead, and if you should not be taking bookings for longer than that, ask an admin to take you out of the booking pool.",
    };
  }
  for (const day of days) {
    const { weekday, start_minute: start, end_minute: end } = day;
    if (!isWholeNumber(weekday) || weekday < 1 || weekday > 7) {
      return { ok: false, error: "Those days could not be read. Please choose them again." };
    }
    const name = DAY_NAMES[weekday];
    if (!isWholeNumber(start) || !isWholeNumber(end)) {
      return { ok: false, error: `${name}'s times could not be read. Please pick a start and end time again.` };
    }
    if (start < 0 || start >= DAY_END_MINUTE) {
      return { ok: false, error: `${name}'s start time is outside the day. Please pick it again.` };
    }
    if (end > DAY_END_MINUTE) {
      return { ok: false, error: `${name}'s end time is outside the day. Please pick it again.` };
    }
    if (end <= start) {
      return { ok: false, error: `${name}'s end time needs to be later than its start time.` };
    }
  }
  // A weekday may hold SEVERAL windows now (#1764), so the check is whether they
  // run into each other rather than whether the day appears twice. A repeated day
  // used to mean a malformed request, and refusing it was right while the form
  // could only send one window per day; the form can now express a split shift, and
  // the engine has always honoured one (`isWithinWorkingHours` returns on the first
  // window of the day that contains the slot).
  //
  // Windows that TOUCH are accepted: noon to 5pm straight after 8am to noon is a
  // legitimate way to say the same thing, storing it as two rules is harmless to the
  // engine, and merging them here would rewrite what the person entered.
  for (const weekday of [...new Set(days.map((d) => d.weekday))]) {
    const windows = days
      .filter((d) => d.weekday === weekday)
      .sort((a, b) => a.start_minute - b.start_minute);
    for (let i = 1; i < windows.length; i++) {
      if (windows[i].start_minute < windows[i - 1].end_minute) {
        return {
          ok: false,
          error: `${DAY_NAMES[weekday]}'s windows overlap each other. Please give each one its own part of the day.`,
        };
      }
    }
  }

  return {
    ok: true,
    // Weekday and THEN start time. `a.weekday - b.weikday` alone stopped being a
    // total order the moment a weekday could hold two windows, and
    // `workingHoursDays` renders a day's windows in the order they arrive, so an
    // unstable sort would put an afternoon window above the morning one it follows.
    rules: [...days].sort(
      (a, b) => a.weekday - b.weekday || a.start_minute - b.start_minute,
    ),
    timezone,
  };
}

/** The same plan from ONE window applied to several days, which is what the org
 *  default seeding and the "use company hours" button still mean. */
export function planUniformSchedule(
  weekdays: number[],
  startMinute: number,
  endMinute: number,
  timezone: string,
): ScheduleReplacementPlan {
  return planScheduleReplacement(
    weekdays.map((weekday) => ({
      weekday,
      start_minute: startMinute,
      end_minute: endMinute,
    })),
    timezone,
  );
}

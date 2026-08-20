/**
 * What replacing a user's weekly hours should write, or why it must be refused
 * (#1293). Pure, no `@/` imports, so it runs node-native.
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

export interface ScheduleRule {
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export type ScheduleReplacementPlan =
  | { ok: true; rules: ScheduleRule[] }
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
export function planScheduleReplacement(days: ScheduleRule[]): ScheduleReplacementPlan {
  if (days.length === 0) {
    return {
      ok: false,
      error: "Pick at least one day you are available. If you are away, submit a time off request instead, and if you should not be taking bookings for longer than that, ask an admin to take you out of the booking pool.",
    };
  }
  const seen = new Set<number>();
  for (const day of days) {
    const { weekday, start_minute: start, end_minute: end } = day;
    if (!isWholeNumber(weekday) || weekday < 1 || weekday > 7) {
      return { ok: false, error: "Those days could not be read. Please choose them again." };
    }
    if (seen.has(weekday)) {
      return { ok: false, error: "That request listed the same day twice. Please choose the days again." };
    }
    seen.add(weekday);
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
  return {
    ok: true,
    rules: [...days].sort((a, b) => a.weekday - b.weekday),
  };
}

/** The same plan from ONE window applied to several days, which is what the org
 *  default seeding and the "use company hours" button still mean. */
export function planUniformSchedule(
  weekdays: number[],
  startMinute: number,
  endMinute: number,
): ScheduleReplacementPlan {
  return planScheduleReplacement(
    weekdays.map((weekday) => ({
      weekday,
      start_minute: startMinute,
      end_minute: endMinute,
    })),
  );
}

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

export function planScheduleReplacement(
  weekdays: number[],
  startMinute: number,
  endMinute: number,
): ScheduleReplacementPlan {
  if (weekdays.length === 0) {
    return {
      ok: false,
      error: "Pick at least one day you are available. If you are away, submit a time off request instead, and if you should not be taking bookings for longer than that, ask an admin to take you out of the booking pool.",
    };
  }
  if (weekdays.some((d) => !isWholeNumber(d) || d < 1 || d > 7)) {
    return { ok: false, error: "Those days could not be read. Please choose them again." };
  }
  if (new Set(weekdays).size !== weekdays.length) {
    return { ok: false, error: "That request listed the same day twice. Please choose the days again." };
  }
  if (!isWholeNumber(startMinute) || !isWholeNumber(endMinute)) {
    return { ok: false, error: "Those times could not be read. Please pick a start and end time again." };
  }
  if (startMinute < 0 || startMinute >= DAY_END_MINUTE) {
    return { ok: false, error: "That start time is outside the day. Please pick it again." };
  }
  if (endMinute > DAY_END_MINUTE) {
    return { ok: false, error: "That end time is outside the day. Please pick it again." };
  }
  if (endMinute <= startMinute) {
    return { ok: false, error: "Your end time needs to be later than your start time." };
  }
  return {
    ok: true,
    rules: weekdays.map((weekday) => ({
      weekday,
      start_minute: startMinute,
      end_minute: endMinute,
    })),
  };
}

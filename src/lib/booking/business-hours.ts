/**
 * Org business hours: the first of the three gates a bookable time passes
 * (#1255, milestone 24). Pure, no `@/` imports, so it runs node-native; the DB
 * read lives beside it in `business-hours-load.ts`.
 *
 * Stored as seven rows, one per weekday, in the SAME shape as an agent's own rules
 * (weekday, start_minute, end_minute) so the gate is a second call to the existing
 * `isWithinWorkingHours` predicate rather than a parallel implementation of the same
 * idea. Minutes are from local midnight, weekdays follow Luxon (1 = Monday), and
 * 1440 is a legitimate end bound (midnight at the end of the day).
 *
 * The failure directions are the reason this is a resolver and not a plain read:
 *
 *   * NO rows means NOT CONFIGURED, so it falls back to the seeded week. A gate that
 *     resolved an empty table to "closed" would blank the booker on a fresh database.
 *   * A day explicitly stored as closed IS closed. That is a decision someone made,
 *     and falling back there would re-open it.
 *   * A row that cannot be trusted refuses the whole week rather than substituting a
 *     default, because widening hours an admin narrowed is the one outcome nobody
 *     would notice: the booker would simply keep offering the old times.
 */
import { DateTime } from "luxon";

/** One open window, the same shape as an agent's `availability_rules` row. */
export interface BusinessWindow {
  weekday: number;
  start_minute: number;
  end_minute: number;
}

/**
 * A specific date the org is shut, or open, whatever the weekly pattern says (#1363).
 *
 * The weekly rows alone could not express "shut for Christmas week", which is the
 * case the honest closure copy (#1328) and the days-back button (#1329) were most
 * obviously written for and the one they could never fire on: during a holiday
 * shutdown the booker would have reported the emptiness as demand.
 *
 * An exception can OPEN a normally shut day as well as close an open one. It is
 * the same table either way, and a one off Saturday is as real a need as a holiday.
 */
export interface BusinessHoursException {
  /** yyyy-mm-dd in the ORG's zone, never in a lead's or an agent's. */
  on_date: string;
  is_open: boolean;
  /** The window that REPLACES the weekday's on an open exception; null when shut. */
  start_minute: number | null;
  end_minute: number | null;
  /** Why, so the admin list reads as a list of holidays rather than of dates. */
  note: string | null;
}

/** A stored row, as read from `business_hours`. */
export interface BusinessHoursRow {
  weekday: number;
  is_open: boolean;
  start_minute: number;
  end_minute: number;
}

export type BusinessHoursResolution =
  | { ok: true; rules: BusinessWindow[]; source: "stored" | "seeded" }
  | { ok: false; error: string };

/**
 * The zone the business hours are expressed in. A coded constant, not a setting:
 * making it admin-editable is a deliberate deferral (the council's ideal-versus-
 * doable list), and an agent's own hours already carry their own zone, so this is
 * only ever the ORG's clock.
 */
export const BUSINESS_ZONE = "America/New_York";

const DAY_END_MINUTE = 1440;
const OPEN_START = 8 * 60; // 08:00
const OPEN_END = 20 * 60; // 20:00

/**
 * The week the migration seeds and the fallback when nothing is stored: Monday to
 * Saturday, 8am to 8pm, Sunday closed (Dan's decision, 2026-08-05). Every value is
 * admin-editable; these are only the starting point.
 */
export const SEEDED_BUSINESS_HOURS: BusinessWindow[] = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  start_minute: OPEN_START,
  end_minute: OPEN_END,
}));

const isWholeNumber = (n: number): boolean => Number.isInteger(n);

/** yyyy-mm-dd, which is the only shape the date key is ever compared as. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The org's window on ONE date, after exceptions, or null when it is shut (#1363).
 *
 * This is the single judge of whether the org is open at a given moment, and every
 * caller has to reach the org's hours through it: consulting `rules` directly
 * answers the weekly pattern, which is the question the exceptions exist to stop
 * anybody asking. `scripts/test-business-hours-exceptions.ts` fails the build on a
 * site that goes around it.
 *
 * An UNREADABLE exception is treated as CLOSED rather than ignored. That is the
 * fail-safe direction here and it is the opposite of the usual one: the rows are
 * only ever written to shut a day or to move its hours, so a row we cannot parse
 * is far likelier to be a closure somebody entered than a day they meant to open,
 * and offering a lead a time on a day the office is dark is the expensive mistake.
 * The database constraint makes the state unreachable through the app; this covers
 * a hand written row.
 */
export function windowOnDate(
  hours: { rules: BusinessWindow[]; exceptions: BusinessHoursException[] },
  isoDate: string,
  weekday: number,
): { start_minute: number; end_minute: number } | null {
  const exception = hours.exceptions.find((e) => e.on_date === isoDate);
  if (exception) {
    if (!exception.is_open) return null;
    const { start_minute: start, end_minute: end } = exception;
    if (start === null || end === null) return null;
    if (!isWholeNumber(start) || !isWholeNumber(end)) return null;
    if (start < 0 || start >= DAY_END_MINUTE || end > DAY_END_MINUTE || end <= start) return null;
    return { start_minute: start, end_minute: end };
  }
  const rule = hours.rules.find((r) => r.weekday === weekday);
  return rule ? { start_minute: rule.start_minute, end_minute: rule.end_minute } : null;
}

/**
 * When the NEXT open business day ends, as epoch ms, or null when the org has no
 * open day inside `lookaheadDays` (#2505).
 *
 * The window the debt tier alarm judges against. Dan, 2026-09-17: "only alert if
 * there are no slots in the next 24 hours/business day (like obviously there
 * would be no slots on sunday)."
 *
 * It starts at TOMORROW rather than today, so the answer is always "the rest of
 * today, plus one whole open day". Taking the end of today would shrink to a
 * minute at 19:59 and page about a tier with nothing left in the last minute of
 * the evening, which is a healthy tier and an alarm nobody would read twice
 * (L36). A flat 24 hours would ask about Sunday on a Saturday evening and page
 * every weekend.
 *
 * Closed days are SKIPPED rather than counted, which is the same sentence: it
 * asks `windowOnDate`, the single judge of whether the org is open on a date, so
 * a holiday exception shutting Monday moves the window to Tuesday and no second
 * copy of the weekly rules is consulted (L107).
 *
 * NULL rather than a guess when no open day is found. An org shut for a fortnight
 * is a real state, and a caller that got a fabricated window would judge a tier
 * against a day nobody is working: the alarm treats null as "could not measure"
 * and concludes nothing, which is the honest answer (L215).
 */
export function nextOpenDayEndMs(
  hours: { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] },
  nowMs: number,
  lookaheadDays = 14,
): number | null {
  const today = DateTime.fromMillis(nowMs, { zone: hours.zone }).startOf("day");
  for (let i = 1; i <= lookaheadDays; i++) {
    const day = today.plus({ days: i });
    const window = windowOnDate(hours, day.toISODate() ?? "", day.weekday);
    if (!window) continue;
    // Wall clock, never an added duration: on a DST transition day adding
    // minutes from midnight shifts the close by the offset delta.
    if (window.end_minute >= DAY_END_MINUTE) return day.plus({ days: 1 }).startOf("day").toMillis();
    return day
      .set({
        hour: Math.floor(window.end_minute / 60),
        minute: window.end_minute % 60,
        second: 0,
        millisecond: 0,
      })
      .toMillis();
  }
  return null;
}

/**
 * The most recent business day that has fully CLOSED, or null when the org had no
 * open day inside `lookbackDays` (#2090).
 *
 * What the Regal feed's quiet alarm judges: "no call from a Slate user all business
 * day" has to be a whole day, or it pages at 8:05 every morning about a day that
 * has barely started. Mid Thursday that is Wednesday; after Thursday's close it is
 * Thursday; on Monday morning after a shut Sunday it is Saturday.
 *
 * Closed days, a holiday exception included, are skipped by asking
 * `windowOnDate`, the single judge of whether the org is open on a date, so no
 * second copy of the weekly rules is consulted (L107). Wall clock arithmetic, as in
 * `nextOpenDayEndMs`, so a DST transition day keeps its real open and close.
 */
export function lastClosedBusinessDay(
  hours: { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] },
  nowMs: number,
  lookbackDays = 14,
): { isoDate: string; openMs: number; closeMs: number } | null {
  const today = DateTime.fromMillis(nowMs, { zone: hours.zone }).startOf("day");
  const at = (day: DateTime, minute: number): number =>
    minute >= DAY_END_MINUTE
      ? day.plus({ days: 1 }).startOf("day").toMillis()
      : day.set({ hour: Math.floor(minute / 60), minute: minute % 60, second: 0, millisecond: 0 }).toMillis();
  for (let i = 0; i <= lookbackDays; i++) {
    const day = today.minus({ days: i });
    const isoDate = day.toISODate() ?? "";
    const window = windowOnDate(hours, isoDate, day.weekday);
    if (!window) continue;
    const closeMs = at(day, window.end_minute);
    if (closeMs > nowMs) continue;
    return { isoDate, openMs: at(day, window.start_minute), closeMs };
  }
  return null;
}

/**
 * Validate the stored exceptions, dropping nothing silently.
 *
 * Returns the rows to use plus the ones that could not be read, so a caller can
 * say so rather than serving a week that quietly ignored a closure. A row with an
 * unusable date is the one that MUST be reported: it does not match any date, so
 * it shuts nothing, and the day it was meant to close stays open.
 */
export function resolveBusinessHoursExceptions(rows: BusinessHoursException[]): {
  exceptions: BusinessHoursException[];
  unreadable: BusinessHoursException[];
} {
  const exceptions: BusinessHoursException[] = [];
  const unreadable: BusinessHoursException[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.on_date !== "string" || !ISO_DATE.test(row.on_date) || seen.has(row.on_date)) {
      unreadable.push(row);
      continue;
    }
    seen.add(row.on_date);
    exceptions.push(row);
  }
  return { exceptions, unreadable };
}

/**
 * The dates the org records as SHUT, in date order (#2764).
 *
 * The low volume alarms leave these out of every fit and every learning window,
 * because their hours gate (the same `windowOnDate` the booker uses) never judges
 * them. Taken from the RESOLVED exceptions, so a row the gate could not read is not
 * a closed day to the floors either: one judge, one answer (L41). An open exception
 * is not a closed day, even when it shortens the day.
 */
export function closedExceptionDates(exceptions: readonly BusinessHoursException[]): string[] {
  return [...new Set(exceptions.filter((e) => !e.is_open).map((e) => e.on_date))].sort();
}

export function resolveBusinessHours(rows: BusinessHoursRow[]): BusinessHoursResolution {
  if (rows.length === 0) {
    return { ok: true, rules: SEEDED_BUSINESS_HOURS, source: "seeded" };
  }
  if (rows.length !== 7) {
    return {
      ok: false,
      error: `business hours are incomplete: ${rows.length} of 7 weekdays are stored`,
    };
  }
  const days = new Set<number>();
  for (const r of rows) {
    if (!isWholeNumber(r.weekday) || r.weekday < 1 || r.weekday > 7) {
      return { ok: false, error: `business hours hold an impossible weekday: ${r.weekday}` };
    }
    if (days.has(r.weekday)) {
      return { ok: false, error: `business hours list weekday ${r.weekday} twice` };
    }
    days.add(r.weekday);
    // A closed day is never offered, so its window is not judged: junk there must
    // not refuse the days that ARE open.
    if (!r.is_open) continue;
    if (!isWholeNumber(r.start_minute) || !isWholeNumber(r.end_minute)) {
      return { ok: false, error: `business hours for weekday ${r.weekday} are unreadable` };
    }
    if (r.start_minute < 0 || r.start_minute >= DAY_END_MINUTE || r.end_minute > DAY_END_MINUTE) {
      return { ok: false, error: `business hours for weekday ${r.weekday} fall outside the day` };
    }
    if (r.end_minute <= r.start_minute) {
      return { ok: false, error: `business hours for weekday ${r.weekday} end before they start` };
    }
  }
  return {
    ok: true,
    rules: rows
      .filter((r) => r.is_open)
      .sort((a, b) => a.weekday - b.weekday)
      .map((r) => ({
        weekday: r.weekday,
        start_minute: r.start_minute,
        end_minute: r.end_minute,
      })),
    source: "stored",
  };
}

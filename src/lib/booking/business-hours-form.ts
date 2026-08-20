import { DateTime } from "luxon";

/**
 * Parse and validate the business-hours editor's form (#1297). Pure, no `@/`
 * imports, so `scripts/test-business-hours-form.ts` drives it node-native.
 *
 * This form decides when Pennie is OPEN, which gates every time every lead is
 * offered, so its failure directions matter more than an ordinary settings field's.
 * Three rules shape the whole thing:
 *
 *  1. SEVEN ROWS OR NOTHING. `resolveBusinessHours` refuses a week that is not
 *     exactly seven weekdays, and a refused week means the loader throws and the
 *     booker offers nothing. A save that could write six rows would take
 *     availability down, so this emits all seven or none.
 *
 *  2. ALL OR NOTHING. One bad day refuses the whole save. Writing the good days and
 *     dropping the bad one would leave the org open on a week nobody chose, and the
 *     person who typed it would be shown a success.
 *
 *  3. AN OPEN DAY'S WINDOW IS REFUSED WHEN UNREADABLE; A CLOSED DAY'S IS REPAIRED.
 *     The table requires an ordered window on EVERY row, including closed ones
 *     (0098's `end_minute > start_minute` has no is_open exemption), yet the
 *     resolver deliberately never reads a closed day's window. So a blank time must
 *     not block someone closing a day, while on an OPEN day it must never quietly
 *     become midnight. 00:00 is a perfectly valid time, so a permissive parse there
 *     would open the org at midnight and report success (L50).
 */

/** A row as `business_hours` stores it. A `type` (not `interface`) so it gains an
 *  implicit index signature and stays assignable to the Supabase insert param, the
 *  same convention core.ts uses. */
export type BusinessHoursFormRow = {
  weekday: number;
  is_open: boolean;
  start_minute: number;
  end_minute: number;
};

export interface BusinessHoursFormResult {
  /** Seven rows ready to store, or EMPTY when anything was refused. */
  rows: BusinessHoursFormRow[];
  errors: string[];
  /** Days going from open to closed, for the pre-save appointment warning. */
  newlyClosed: number[];
}

/**
 * The window a CLOSED day falls back to when its own is unreadable. Never offered
 * to anyone: it exists only because the table demands an ordered pair on every row.
 */
export const CLOSED_DAY_FALLBACK = { start_minute: 8 * 60, end_minute: 20 * 60 };

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const DAY_END_MINUTE = 1440;

/**
 * Minutes from local midnight for a strict `HH:MM`, or `null` when it cannot be
 * read. Null rather than a number on purpose: the caller has to decide what an
 * unreadable time means for THAT day, and for an open day the answer is "refuse".
 */
function parseTime(raw: string | undefined): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec((raw ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function parseBusinessHoursForm(
  form: Record<string, string | undefined>,
  opts: { currentlyOpen?: number[] } = {},
): BusinessHoursFormResult {
  const rows: BusinessHoursFormRow[] = [];
  const errors: string[] = [];
  const newlyClosed: number[] = [];
  const wasOpen = new Set(opts.currentlyOpen ?? []);

  for (const weekday of WEEKDAYS) {
    const day = DAY_NAMES[weekday];
    // An unchecked box posts nothing at all, which is how a day is closed.
    const isOpen = (form[`bh_open_${weekday}`] ?? "") !== "";
    const start = parseTime(form[`bh_start_${weekday}`]);
    const end = parseTime(form[`bh_end_${weekday}`]);

    if (!isOpen) {
      if (wasOpen.has(weekday)) newlyClosed.push(weekday);
      // Keep the day's own window when it is readable, so re-opening the day
      // restores the hours it had rather than silently coming back as something
      // else. Repair only what the table would reject.
      const keep =
        start !== null && end !== null && end > start
          ? { start_minute: start, end_minute: end }
          : CLOSED_DAY_FALLBACK;
      rows.push({ weekday, is_open: false, ...keep });
      continue;
    }

    if (start === null) {
      errors.push(`${day}: enter an opening time, or close the day.`);
      continue;
    }
    if (end === null) {
      errors.push(`${day}: enter a closing time, or close the day.`);
      continue;
    }
    if (end <= start) {
      errors.push(`${day}: the closing time must be after the opening time.`);
      continue;
    }
    if (start < 0 || start >= DAY_END_MINUTE || end > DAY_END_MINUTE) {
      errors.push(`${day}: those hours fall outside the day.`);
      continue;
    }
    rows.push({ weekday, is_open: true, start_minute: start, end_minute: end });
  }

  // All or nothing: a partial week is the one outcome that would break the booker.
  if (errors.length > 0) return { rows: [], errors, newlyClosed };
  return { rows, errors, newlyClosed };
}

/**
 * How many of these booking instants fall on one of `weekdays`, judged in the ORG's
 * zone. Feeds the warning shown before closing a day that already holds appointments.
 *
 * The zone is load-bearing. A booking stored as `2026-06-09T01:00Z` is Monday 21:00
 * in New York, and reading it as UTC would file it under Tuesday: the editor would
 * then warn about closing the wrong day, or stay silent about the right one.
 *
 * An UNREADABLE instant COUNTS. It is a booking we cannot place, and the warning
 * exists to stop someone closing a day they believe is empty, so the fail-safe
 * direction is to include it rather than let it vanish from the total.
 */
export function countBookingsOnWeekdays(
  startIsos: string[],
  zone: string,
  weekdays: number[],
): number {
  if (weekdays.length === 0) return 0;
  const wanted = new Set(weekdays);
  let count = 0;
  for (const iso of startIsos) {
    const dt = DateTime.fromISO(iso, { zone });
    if (!dt.isValid) {
      count++;
      continue;
    }
    if (wanted.has(dt.weekday)) count++;
  }
  return count;
}


/**
 * A date exception as `business_hours_exceptions` stores it (#1363). A `type`, for
 * the same reason its weekly sibling above is one.
 */
export type BusinessHoursExceptionRow = {
  on_date: string;
  is_open: boolean;
  start_minute: number | null;
  end_minute: number | null;
  note: string | null;
};

export interface ExceptionFormResult {
  row: BusinessHoursExceptionRow | null;
  errors: string[];
}

/** yyyy-mm-dd, and a real date: Luxon rejects 2026-02-30, a regex would not. */
function readIsoDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const dt = DateTime.fromISO(trimmed);
  return dt.isValid && dt.toISODate() === trimmed ? trimmed : null;
}

/**
 * Parse the add-a-date form (#1363).
 *
 * The asymmetry mirrors the weekly form's third rule, and the table's own
 * constraint: an OPEN exception must carry a usable window, because a blank time
 * silently becoming midnight would open the org at midnight and report success
 * (L50); a CLOSED one must carry no window at all, because a stored pair on a
 * closed date would let a later reader treat the closure as odd opening hours.
 *
 * The note is optional and trimmed to null, because an empty string in the column
 * would render as a blank line in the admin list rather than as no note.
 */
export function parseExceptionForm(raw: Record<string, string>): ExceptionFormResult {
  const errors: string[] = [];
  const on_date = readIsoDate(raw.on_date ?? "");
  if (!on_date) errors.push("Enter the date as a real calendar date.");

  const is_open = (raw.state ?? "closed") === "open";
  let start_minute: number | null = null;
  let end_minute: number | null = null;

  if (is_open) {
    start_minute = parseTime(raw.start);
    end_minute = parseTime(raw.end);
    if (start_minute === null || end_minute === null) {
      errors.push("An open date needs a start and an end time, as HH:MM.");
    } else if (end_minute <= start_minute) {
      errors.push("An open date has to end after it starts.");
    }
  }

  if (errors.length > 0 || !on_date) return { row: null, errors };
  const note = (raw.note ?? "").trim();
  return {
    row: { on_date, is_open, start_minute, end_minute, note: note === "" ? null : note },
    errors: [],
  };
}

/**
 * How many future bookings fall on a given date, in the ORG's zone (#1363).
 *
 * Mirrors `countBookingsOnWeekdays`, including its one deliberate oddity: an
 * unreadable stamp COUNTS. The number exists to warn somebody before they shut a
 * day, so a stamp we cannot read has to inflate the warning rather than quietly
 * shrink it (L50).
 */
export function countBookingsOnDate(startIsos: string[], zone: string, isoDate: string): number {
  let count = 0;
  for (const iso of startIsos) {
    const dt = DateTime.fromISO(iso, { zone });
    if (!dt.isValid) {
      count++;
      continue;
    }
    if (dt.toISODate() === isoDate) count++;
  }
  return count;
}

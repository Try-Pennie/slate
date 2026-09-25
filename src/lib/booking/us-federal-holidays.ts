/**
 * The US federal holidays, and which of the upcoming ones the org's business hours
 * have not decided (#2767).
 *
 * WHY. The low volume alarms (#1956, #2738) judge a quiet hour against the org's own
 * hours, date exceptions included, so a holiday the exceptions do not carry is an
 * ordinary open day to them. Replayed over real bookings, the per page alarm paged
 * the Follow Up page eight times on Labor Day 2026-09-07 (#2738). Before either alarm is
 * armed, every upcoming federal holiday must be a DECISION somebody made: a closed
 * exception, an open one (the org is working that day, on purpose), or a weekday the
 * org never opens anyway.
 *
 * The calendar is the one 5 U.S.C. 6103 sets, with its observed rule: a holiday on a
 * Saturday is observed the Friday before, one on a Sunday the Monday after. Both the
 * day itself and its observed weekday are listed, because the org is open on
 * Saturdays, so a Saturday holiday and its Friday can each be the quiet one.
 *
 * Pure date arithmetic on calendar dates (no zone, no clock), so it runs node native
 * and its tests pin dates read off the published calendar.
 */

export interface FederalHoliday {
  /** ISO calendar date, YYYY-MM-DD. */
  date: string;
  name: string;
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 0 = Sunday .. 6 = Saturday, for a calendar date. */
function dayOfWeek(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The `n`th given weekday (0 = Sunday) of a month, or the last one when `n` is -1. */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  if (n === -1) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const back = (dayOfWeek(y, m, last) - weekday + 7) % 7;
    return last - back;
  }
  const first = (weekday - dayOfWeek(y, m, 1) + 7) % 7;
  return 1 + first + (n - 1) * 7;
}

/** The eleven federal holidays of one year, on their actual dates, in date order. */
export function usFederalHolidays(year: number): FederalHoliday[] {
  const MON = 1;
  const THU = 4;
  return [
    { date: iso(year, 1, 1), name: "New Year's Day" },
    { date: iso(year, 1, nthWeekday(year, 1, MON, 3)), name: "Martin Luther King Jr. Day" },
    { date: iso(year, 2, nthWeekday(year, 2, MON, 3)), name: "Washington's Birthday" },
    { date: iso(year, 5, nthWeekday(year, 5, MON, -1)), name: "Memorial Day" },
    { date: iso(year, 6, 19), name: "Juneteenth" },
    { date: iso(year, 7, 4), name: "Independence Day" },
    { date: iso(year, 9, nthWeekday(year, 9, MON, 1)), name: "Labor Day" },
    { date: iso(year, 10, nthWeekday(year, 10, MON, 2)), name: "Columbus Day" },
    { date: iso(year, 11, 11), name: "Veterans Day" },
    { date: iso(year, 11, nthWeekday(year, 11, THU, 4)), name: "Thanksgiving Day" },
    { date: iso(year, 12, 25), name: "Christmas Day" },
  ];
}

function addDays(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Luxon weekday (1 = Monday .. 7 = Sunday) of a calendar date, the convention Slate stores. */
export function luxonWeekday(dateIso: string): number {
  const [y, m, d] = dateIso.split("-").map(Number);
  const js = dayOfWeek(y!, m!, d!);
  return js === 0 ? 7 : js;
}

/**
 * Every date inside `[todayIso, todayIso + windowDays]` a holiday falls on or is
 * observed on, in date order. The observed weekday carries "(observed)" in its name.
 */
export function holidayDatesToDecide(todayIso: string, windowDays: number): FederalHoliday[] {
  const endIso = addDays(todayIso, windowDays);
  const firstYear = Number(todayIso.slice(0, 4));
  const lastYear = Number(endIso.slice(0, 4));
  const out: FederalHoliday[] = [];
  // One year either side, because a New Year's Day on a Saturday is observed on
  // 31 December of the year before.
  for (let y = firstYear - 1; y <= lastYear + 1; y++) {
    for (const h of usFederalHolidays(y)) {
      out.push(h);
      const wd = luxonWeekday(h.date);
      if (wd === 6) out.push({ date: addDays(h.date, -1), name: `${h.name} (observed)` });
      if (wd === 7) out.push({ date: addDays(h.date, 1), name: `${h.name} (observed)` });
    }
  }
  return out
    .filter((h) => h.date >= todayIso && h.date <= endIso)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * The upcoming holiday dates nobody has decided: no exception row on the date (open
 * or closed, either is a decision), on a weekday the weekly pattern opens.
 */
export function uncoveredHolidays(input: {
  todayIso: string;
  windowDays: number;
  /** Luxon weekdays the weekly pattern opens. */
  openWeekdays: readonly number[];
  /** Every date carrying an exception row, open or closed. */
  exceptionDates: readonly string[];
}): FederalHoliday[] {
  const open = new Set(input.openWeekdays);
  const excepted = new Set(input.exceptionDates);
  return holidayDatesToDecide(input.todayIso, input.windowDays).filter(
    (h) => !excepted.has(h.date) && open.has(luxonWeekday(h.date)),
  );
}

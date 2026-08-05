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

/** One open window, the same shape as an agent's `availability_rules` row. */
export interface BusinessWindow {
  weekday: number;
  start_minute: number;
  end_minute: number;
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

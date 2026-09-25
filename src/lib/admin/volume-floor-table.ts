/**
 * The measured low volume floors as /admin/alerts shows them (#1956).
 *
 * Only the hours the alarm actually judges: the org's open days, and the hours
 * inside their windows. A floor for a Sunday or for 3am would be a number nothing
 * ever compares against, and a table full of them reads as though they matter.
 *
 * When the week could not be read, every day and hour is shown and the caller says
 * so, rather than the table silently shrinking to nothing (L10).
 *
 * No `@/` imports, so a node suite can drive it.
 */
import { WEEKDAY_NAMES, type VolumeBaseline } from "../monitor/volume-floors.ts";

export { hourLabel } from "../monitor/volume-floors.ts";

/** One hour of one day. Null where that day's own window does not reach the hour. */
export interface FloorTableCell {
  hour: number;
  floor120: number | null;
  typical120: number | null;
}

export interface FloorTable {
  /** The clock hours shown as columns, in order. */
  hours: number[];
  rows: { weekday: number; label: string; cells: FloorTableCell[] }[];
  /**
   * The 30 minute floors, or null when every shown hour's is 0, so that window can
   * never fire on this traffic and saying so once beats a grid of zeros.
   */
  shortRows: { weekday: number; label: string; floors: (number | null)[] }[] | null;
}

export function floorTable(
  baseline: VolumeBaseline,
  week: { rules: { weekday: number; start_minute: number; end_minute: number }[] } | null,
): FloorTable {
  const open = week
    ? [...week.rules].sort((a, b) => a.weekday - b.weekday)
    : Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, start_minute: 0, end_minute: 24 * 60 }));
  const hourSet = new Set<number>();
  for (const r of open) {
    // An hour is shown when any tick inside it is judged: the check runs through
    // the hour that holds the window's last minute.
    for (let h = Math.floor(r.start_minute / 60); h * 60 < r.end_minute; h++) hourSet.add(h);
  }
  const hours = [...hourSet].sort((a, b) => a - b);
  const inWindow = (weekday: number, hour: number) =>
    open.some((r) => r.weekday === weekday && hour * 60 + 59 >= r.start_minute && hour * 60 < r.end_minute);

  const rows = open.map((r) => ({
    weekday: r.weekday,
    label: WEEKDAY_NAMES[r.weekday - 1]!,
    cells: hours.map((hour) => {
      const c = baseline.cells[r.weekday - 1]![hour]!;
      // Outside this day's own window the alarm never judges, so nothing is shown.
      return inWindow(r.weekday, hour)
        ? { hour, floor120: c.floor120, typical120: c.typical120 }
        : { hour, floor120: null, typical120: null };
    }),
  }));
  const shortRows = open.map((r) => ({
    weekday: r.weekday,
    label: WEEKDAY_NAMES[r.weekday - 1]!,
    floors: hours.map((hour) => (inWindow(r.weekday, hour) ? baseline.cells[r.weekday - 1]![hour]!.floor30 : null)),
  }));
  const silent = shortRows.every((r) => r.floors.every((f) => f === null || f === 0));
  return { hours, rows, shortRows: silent ? null : shortRows };
}

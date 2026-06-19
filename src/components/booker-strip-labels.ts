import { DateTime } from "luxon";
export function stripDayLabel(iso: string, today: DateTime, zone: string): string {
  const d = DateTime.fromISO(iso, { zone });
  const days = Math.round(d.startOf("day").diff(today.startOf("day"), "days").days);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return d.toFormat("ccc");
}

/** The 7 ISO dates of the rolling week starting today (today .. today+6). */
export function bookerWeekDays(today: DateTime): string[] {
  return Array.from({ length: 7 }, (_, i) => today.plus({ days: i }).toISODate()!);
}

/** A strip day is bookable iff it has availability AND is not a Sunday. */
export function isStripDayEnabled(iso: string, availableDays: string[], zone: string): boolean {
  if (DateTime.fromISO(iso, { zone }).weekday === 7) return false; // Sunday always off
  return availableDays.includes(iso);
}

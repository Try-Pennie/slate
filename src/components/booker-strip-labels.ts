import { DateTime } from "luxon";
export function stripDayLabel(iso: string, today: DateTime, zone: string): string {
  const d = DateTime.fromISO(iso, { zone });
  const days = Math.round(d.startOf("day").diff(today.startOf("day"), "days").days);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return d.toFormat("ccc");
}

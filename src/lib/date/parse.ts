import { DateTime } from "luxon";

/**
 * Round an "HH:MM" time string DOWN to the nearest quarter hour (:00/:15/:30/
 * :45) — e.g. 09:01 and 09:14 both become 09:00. Returns the input unchanged if
 * it isn't a well-formed time (empty stays empty).
 */
export function roundDownToQuarterHour(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return hhmm;
  const rounded = Math.floor(min / 15) * 15;
  return `${String(h).padStart(2, "0")}:${String(rounded).padStart(2, "0")}`;
}

/**
 * Round an "HH:MM" time string UP to the nearest quarter hour — e.g. 17:01 and
 * 17:14 both become 17:15. Use for END times, where rounding down would shorten
 * the window. Clamps to 23:45 (the last same-day quarter) rather than spilling
 * to the next day. Returns the input unchanged if it isn't a well-formed time.
 */
export function roundUpToQuarterHour(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return hhmm;
  const up = Math.ceil((h * 60 + min) / 15) * 15;
  if (up >= 24 * 60) return "23:45";
  return `${String(Math.floor(up / 60)).padStart(2, "0")}:${String(up % 60).padStart(2, "0")}`;
}

/**
 * Build a start-of-day DateTime from separate month/day/year segments, or null
 * if any segment is malformed or the combination isn't a real calendar date
 * (e.g. month 13, or Feb 30). Year must be 4 digits; month/day 1-2 digits.
 */
export function dateFromParts(
  mm: string,
  dd: string,
  yyyy: string,
): DateTime | null {
  if (!/^\d{1,2}$/.test(mm) || !/^\d{1,2}$/.test(dd) || !/^\d{4}$/.test(yyyy)) {
    return null;
  }
  const d = DateTime.fromObject({
    month: Number(mm),
    day: Number(dd),
    year: Number(yyyy),
  });
  return d.isValid ? d.startOf("day") : null;
}

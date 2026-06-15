import { DateTime } from "luxon";

// Formats accepted from the date field's text box, tried in order after a
// plain ISO parse. Kept pure (no React) so it's unit-testable.
const PARSE_FORMATS = [
  "M/d/yyyy",
  "M-d-yyyy",
  "M/d/yy",
  "LLLL d, yyyy",
  "LLLL d yyyy",
  "LLL d, yyyy",
  "LLL d yyyy",
  "M/d",
];

/**
 * Parse a free-typed date string into a start-of-day DateTime, or null when it
 * can't be read. Tries ISO (yyyy-MM-dd) first, then the human formats above
 * (m/d/yyyy, "Jun 20 2026", etc.). Used for paste into the segmented field.
 */
export function parseTypedDate(text: string): DateTime | null {
  const t = text.trim();
  if (!t) return null;
  const iso = DateTime.fromISO(t);
  if (iso.isValid) return iso.startOf("day");
  for (const fmt of PARSE_FORMATS) {
    const d = DateTime.fromFormat(t, fmt);
    if (d.isValid) return d.startOf("day");
  }
  return null;
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

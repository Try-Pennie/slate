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
 * (m/d/yyyy, "Jun 20 2026", etc.).
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

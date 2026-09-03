import { DateTime } from "luxon";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "HH:MM" split into whole hours and minutes, or null if it is not one. */
function timeParts(hhmm: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * A time of day as a person reads it: `9:00am`, `12:00pm`, `11:45pm`. Null when
 * the input is not a readable "HH:MM".
 *
 * THE spelling, for every surface that prints a time (#1765). Five places
 * rendered this three different ways (`9:00am`, `9:00 AM`, `09:00 AM`); the
 * lowercase form is what a lead already sees in the booker and what the time off
 * form uses, so it is the one kept. Null rather than a fallback string on purpose:
 * a formatter that answered `12:00am` for an unreadable value would put a real
 * looking time on screen for a value nobody chose.
 */
export function formatTimeOfDay(hhmm: string): string | null {
  const parts = timeParts(hhmm);
  if (!parts) return null;
  const hour12 = parts.hour % 12 || 12;
  return `${hour12}:${pad2(parts.minute)}${parts.hour < 12 ? "am" : "pm"}`;
}

/** Every quarter hour of the day as "HH:MM", 00:00 through 23:45. */
export const QUARTER_HOUR_TIMES: string[] = Array.from({ length: 96 }, (_, i) => {
  const minutes = i * 15;
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
});

/** Whether a time sits on the quarter hour grid the pickers offer. */
export function isQuarterHour(hhmm: string): boolean {
  const parts = timeParts(hhmm);
  return parts !== null && parts.minute % 15 === 0;
}

export interface TimeOption {
  /** 24 hour "HH:MM", which is what the field submits. */
  value: string;
  /** How it is spelled on screen, always from {@link formatTimeOfDay}. */
  label: string;
}

/**
 * The whole day as pickable options, so no storable window is unenterable and no
 * stored value can fail to display (#1764). Labels come from
 * {@link formatTimeOfDay} rather than a second expression here.
 */
export function quarterHourOptions(): TimeOption[] {
  return QUARTER_HOUR_TIMES.map((value) => ({
    value,
    label: formatTimeOfDay(value) ?? value,
  }));
}

/** A typed query split into what the person has said so far. */
function queryParts(
  text: string,
): { hourDigits: string; minuteDigits: string; meridiem: "a" | "p" | null } | null {
  const normalized = text.toLowerCase().replace(/[\s.]/g, "");
  const m = /^(\d{1,2})(?::?(\d{0,2}))?(am?|pm?)?$/.exec(normalized);
  if (!m) return null;
  return {
    hourDigits: m[1],
    minuteDigits: m[2] ?? "",
    meridiem: m[3] ? (m[3][0] as "a" | "p") : null,
  };
}

/**
 * The options a partially typed time still matches, in chronological order.
 *
 * A query carrying no am or pm matches BOTH halves of the day, so reaching 5:15pm
 * is `5:15p` rather than a scroll through the morning, and a 24 hour query (`17`)
 * works too because that is what the field submits and what somebody reading a
 * stored value will type back. An unreadable query matches nothing, which is the
 * field's refused state rather than a silent fall back to the whole list.
 */
export function filterTimeOptions(query: string): TimeOption[] {
  if (query.trim() === "") return quarterHourOptions();
  const parts = queryParts(query);
  if (!parts) return [];
  return quarterHourOptions().filter((o) => {
    const p = timeParts(o.value);
    if (!p) return false;
    if (parts.meridiem && parts.meridiem !== (p.hour < 12 ? "a" : "p")) return false;
    const hour12 = p.hour % 12 || 12;
    const hourMatches = [String(hour12), String(p.hour), pad2(p.hour)].some((h) =>
      h.startsWith(parts.hourDigits),
    );
    if (!hourMatches) return false;
    return parts.minuteDigits === "" || pad2(p.minute).startsWith(parts.minuteDigits);
  });
}

export type TypedTime =
  | { ok: true; value: string }
  | { ok: false; reason: "blank" | "unreadable" | "off-grid" };

/**
 * What a person typed into a time field, resolved to a canonical "HH:MM" or
 * refused with the reason.
 *
 * Three refusals rather than one, because they mean different things to the form
 * (#1764). `blank` is an ordinary state: an added window nobody filled in, or an
 * unticked day, and it must not refuse the save. `off-grid` is a real time that is
 * not one of the 96 offered, and it BLOCKS the save rather than snapping, because
 * snapping something a person just typed would move their hours without saying so.
 * `unreadable` is not a time at all. One answer for all three would make an empty
 * added row refuse a save that should go through.
 */
export function resolveTypedTime(text: string): TypedTime {
  if (text.trim() === "") return { ok: false, reason: "blank" };
  const parts = queryParts(text);
  if (!parts || parts.minuteDigits.length === 1) return { ok: false, reason: "unreadable" };
  const minute = parts.minuteDigits === "" ? 0 : Number(parts.minuteDigits);
  const typedHour = Number(parts.hourDigits);
  if (minute > 59) return { ok: false, reason: "unreadable" };

  let hour: number;
  if (parts.meridiem) {
    // With am or pm the hour is a 12 hour clock reading, so 13pm is not a time.
    if (typedHour < 1 || typedHour > 12) return { ok: false, reason: "unreadable" };
    hour = (typedHour % 12) + (parts.meridiem === "p" ? 12 : 0);
  } else {
    if (typedHour > 23) return { ok: false, reason: "unreadable" };
    hour = typedHour;
  }
  const value = `${pad2(hour)}:${pad2(minute)}`;
  if (!isQuarterHour(value)) return { ok: false, reason: "off-grid" };
  return { ok: true, value };
}

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

import { DateTime } from "luxon";

/**
 * Two digit padding, exported because the segmented date and time field needs the
 * same one and used to carry its own (#1765). A second `pad` is harmless on its
 * own; the point is that it sat beside a second `to24` and a second snapping rule,
 * and only one of those three was wrong.
 */
export const padTwo = (n: number) => String(n).padStart(2, "0");
const pad2 = padTwo;

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

/**
 * The same spelling, from a Luxon `DateTime`: `5:15pm`. Null for an invalid one,
 * for the same reason {@link formatTimeOfDay} answers null rather than a plausible
 * looking time for a value nobody chose.
 *
 * It answers THROUGH `formatTimeOfDay` rather than with its own `toFormat` call,
 * so the two entry points cannot drift into a fourth spelling (#1765: five sites
 * rendered this three different ways).
 */
export function formatClockTime(dt: DateTime): string | null {
  if (!dt.isValid) return null;
  return formatTimeOfDay(dt.toFormat("HH:mm"));
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

/**
 * A typed query split into what the person has said so far.
 *
 * `hourFinished` is the part that is not obvious (#1965). The hour is matched by
 * PREFIX while it could still grow, so typing `1` offers the ones, the tens, the
 * elevens and the twelves, which is right: any of them might be what somebody is
 * reaching for. Once they have typed ANYTHING PAST the hour, though, the hour
 * cannot grow another digit, and going on matching by prefix offered fourteen
 * hours for `1:00` and forty for `1p`.
 *
 * The separator has to be reported SEPARATELY from the minute digits, because
 * the old regex could not tell `"1"` from `"1:"`: its optional group matched the
 * colon with zero digits, so both arrived with `minuteDigits` of `""`. Deciding
 * on `minuteDigits !== ""` alone would leave `"1:"` still matching fourteen
 * hours, and a typed colon is the moment the person has visibly committed.
 */
function queryParts(text: string): {
  hourDigits: string;
  minuteDigits: string;
  meridiem: "a" | "p" | null;
  hourFinished: boolean;
} | null {
  const normalized = text.toLowerCase().replace(/[\s.]/g, "");
  const m = /^(\d{1,2})(:?)(\d{0,2})(am?|pm?)?$/.exec(normalized);
  if (!m) return null;
  const minuteDigits = m[3] ?? "";
  const meridiem = m[4] ? (m[4][0] as "a" | "p") : null;
  return {
    hourDigits: m[1],
    minuteDigits,
    meridiem,
    hourFinished: m[2] === ":" || minuteDigits !== "" || meridiem !== null,
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
    const spellings = [String(hour12), String(p.hour), pad2(p.hour)];
    // Prefix while the hour can still grow, exact once it cannot (#1965).
    const hourMatches = parts.hourFinished
      ? spellings.includes(parts.hourDigits)
      : spellings.some((h) => h.startsWith(parts.hourDigits));
    if (!hourMatches) return false;
    return parts.minuteDigits === "" || pad2(p.minute).startsWith(parts.minuteDigits);
  });
}

/**
 * A 12 hour clock reading as the 24 hour "HH:MM" a form submits.
 *
 * `hour12` of 0 means "nothing typed yet" and answers the empty string rather
 * than midnight: a half filled field must not submit a real time (L67).
 */
export function timeFrom12Hour(hour12: number, minute: number, ampm: "AM" | "PM"): string {
  if (!hour12) return "";
  let hour = hour12 % 12;
  if (ampm === "PM") hour += 12;
  return `${padTwo(hour)}:${padTwo(minute)}`;
}

/** "HH:MM" as the three segments a 12 hour field shows, or null if unreadable. */
export function twelveHourParts(
  hhmm: string,
): { hour12: number; minute: number; ampm: "AM" | "PM" } | null {
  const parts = timeParts(hhmm);
  if (!parts) return null;
  return {
    hour12: parts.hour % 12 || 12,
    minute: parts.minute,
    ampm: parts.hour < 12 ? "AM" : "PM",
  };
}

/**
 * Snap a whole time to the quarter hour grid, in the given direction.
 *
 * THE fix for #1765, and the reason it takes a time rather than a minute. The
 * time off form snapped the MINUTE in isolation: `ceil(50 / 15) * 15` is 60,
 * which is not a minute, so it answered 45 and left the hour alone. A typed 5:50pm
 * END became 5:45pm, fourteen minutes SHORTER than asked for, in the one direction
 * its own comment said rounding must never take. A time is a single quantity and
 * has to be rounded as one.
 */
export function snapTimeOfDay(hhmm: string, direction: "up" | "down"): string {
  return direction === "up" ? roundUpToQuarterHour(hhmm) : roundDownToQuarterHour(hhmm);
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
export function resolveTypedTime(text: string, standing?: string | null): TypedTime {
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
    // A BARE 12 HOUR TIME KEEPS THE HALF OF THE DAY THE FIELD WAS ALREADY ON
    // (#1964, Dan's call on 2026-09-04).
    //
    // Without this, editing part of a time silently moved it twelve hours.
    // Double clicking the minutes of "5:00pm" selects "00pm", because the field
    // is one text input and the browser's own word rules group the meridiem with
    // the digits, so typing 15 leaves "5:15". That has no meridiem, so it read as
    // 05:15: a shift to the other half of the day, on the quarter hour grid, and
    // therefore VALID. The component's careful refusal of an off grid time never
    // fired, nothing was announced, and a working hours save moved somebody's
    // shift to the morning.
    //
    // The 24 hour reading has to survive, because it is what makes "13:00" work
    // and it is what somebody reading a stored value types back. So the line is
    // drawn at the only hours where the two readings DISAGREE, which is 1 to 11.
    //
    // 0 and 13 to 23 have no 12 hour spelling at all, so there is nothing to
    // inherit. TWELVE IS THE ONE THAT LOOKS LIKE IT SHOULD AND MUST NOT: as a 24
    // hour reading "12:30" is half past noon, and noon is already pm, so
    // inheriting would only ever change it in the am case, where it would move
    // half past noon to half past MIDNIGHT. That is a fresh twelve hour shift
    // introduced by the fix for twelve hour shifts, in the commonest hour anybody
    // types. Somebody who means midnight types "12:30a", which still works.
    //
    // What is left is somebody who genuinely means 05:15 while the field shows
    // pm, which is rarer than the partial edit and, unlike today, is a reading
    // they can see in the field and correct.
    const inherited = standingMeridiem(standing);
    if (inherited && typedHour >= 1 && typedHour <= 11) {
      hour = (typedHour % 12) + (inherited === "p" ? 12 : 0);
    } else {
      hour = typedHour;
    }
  }
  const value = `${pad2(hour)}:${pad2(minute)}`;
  if (!isQuarterHour(value)) return { ok: false, reason: "off-grid" };
  return { ok: true, value };
}

/**
 * Which half of the day a standing "HH:MM" value is on, or null when there is
 * nothing to inherit.
 *
 * Null for an absent, blank or unreadable value, which is what makes a brand new
 * empty row behave exactly as it did: with nothing standing there is nothing to
 * inherit and a bare time is read as 24 hour, as before.
 */
function standingMeridiem(standing: string | null | undefined): "a" | "p" | null {
  if (!standing) return null;
  const p = timeParts(standing);
  if (!p) return null;
  return p.hour < 12 ? "a" : "p";
}

/**
 * The part of a typed time the caret is sitting in, as a selection range (#1964).
 *
 * `TimeField` is one text input holding the whole time, which is #1764's design
 * and a good one: "5:15p" reaches 5:15pm in five keystrokes where three dropdowns
 * took three menus. The cost is that it has no SEGMENTS, so a double click falls
 * to the browser's own word rules, and those group "00pm" as a single word.
 * Dan could not select the minutes on their own.
 *
 * So the gesture is given the meaning it should have had: it selects the hour,
 * the minutes or the meridiem, whichever the pointer is on. Pure and returning a
 * range rather than touching the DOM, so every boundary is testable without a
 * browser.
 *
 * Returns null when the text is not a time it can read, which leaves the browser
 * to do whatever it would have done rather than selecting something arbitrary.
 */
export function timeSegmentAt(
  text: string,
  caret: number,
): { start: number; end: number } | null {
  // Read the three parts off the RAW text rather than a normalized copy, since
  // the offsets have to point back into what is on screen.
  const m = /^(\s*)(\d{1,2})(:?)(\d{0,2})\s*([ap]\.?m?\.?)?\s*$/i.exec(text);
  if (!m) return null;

  const lead = m[1].length;
  const hour = { start: lead, end: lead + m[2].length };
  const sepEnd = hour.end + m[3].length;
  const minute = { start: sepEnd, end: sepEnd + m[4].length };
  // The meridiem may be preceded by spaces, so it is found rather than assumed
  // to start where the minutes ended.
  const meridiem = m[5]
    ? { start: text.toLowerCase().lastIndexOf(m[5].toLowerCase()), end: text.trimEnd().length }
    : null;

  // No clamping: a caret past the end falls to the last segment and one before
  // the start to the first, by the comparisons below. A clamp was written here
  // first and removed when a mutation showed it could not change any answer,
  // which makes it defensive code no test can fail (L29). The two out of range
  // cases are still asserted, so the behaviour is pinned rather than assumed.
  const at = caret;

  // THE BOUNDARY BETWEEN THE MINUTES AND THE MERIDIEM IS GENUINELY AMBIGUOUS, and
  // it is broken toward the MINUTES. A caret is a position BETWEEN characters, so
  // the browser reports the same offset for a click on the right half of the last
  // digit and one on the left half of the meridiem's first letter. Measured in
  // Chromium on the real field: clicking the second "0" of "5:00pm" reports 4,
  // which is also what clicking the left of the "p" reports.
  //
  // Minutes win because editing them is the gesture this exists for, and getting
  // the meridiem when you clicked a DIGIT is the failure being fixed. The cost is
  // that the meridiem's first letter is half a target: it is still selected from
  // its second character on, and typing "a" or "p" over any selection changes it
  // anyway.
  if (meridiem && at > minute.end) return meridiem;
  // A caret exactly on the separator belongs to the MINUTES, which is the part
  // somebody double clicking near the colon is reaching for: the hour is one
  // click to the left and is a shorter target.
  if (minute.end > minute.start && at >= minute.start) return minute;
  if (at <= hour.end) return hour;
  // Past the hour with no minutes and no meridiem to claim it: the hour is the
  // only thing there.
  return hour;
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

/**
 * A week of working hours as the form reads it, and the sentence that says what it
 * is (#1764). Pure, so both the server component that renders the rows and the
 * client editor that lets somebody change them read the same rules.
 *
 * The week is one row per weekday holding a LIST of windows, because the engine
 * has always honoured several windows a day (`isWithinWorkingHours` loops every
 * rule matching the day and returns on the first that contains the slot) while the
 * form could express only one. That gap used to be handled by counting the windows
 * the form could not show and warning, in red, that saving would destroy them
 * (#1308). Showing them is better than warning about them.
 */

import { formatTimeOfDay } from "./date/parse";
import { WEEKDAY_NAMES, minutesToTime, weekdayPhrase } from "./schedule-core";

/** One window of a working day, in the agent's own zone, as "HH:MM". */
export interface WorkingHoursWindow {
  start: string;
  end: string;
}

/** One weekday's row, as the page reads it back from the stored rules. */
export interface WorkingHoursDay {
  weekday: number;
  on: boolean;
  /** In start order, and never empty: a row always offers at least one window. */
  windows: WorkingHoursWindow[];
}

export const WEEKDAYS: [number, string][] = [1, 2, 3, 4, 5, 6, 7].map((d) => [
  d,
  WEEKDAY_NAMES[d],
]);

/** The window a day with nothing stored starts on, so ticking a day is one click
 *  and the ordinary case (the same hours all week) is still one edit. */
export const DEFAULT_DAY: WorkingHoursWindow = {
  start: minutesToTime(540),
  end: minutesToTime(1020),
};

/**
 * The stored rules as the form reads them: one row per weekday, holding every
 * window that weekday has.
 *
 * `fallbackWeekdays` decides which days are ticked when NOTHING is stored, which is
 * a new agent rather than one who has cleared their week (the planner refuses an
 * empty week, so a stored empty is not a state that exists).
 */
export function workingHoursDays(
  rules: { weekday: number; start_minute: number; end_minute: number }[],
  fallbackWeekdays: number[] = [1, 2, 3, 4, 5],
): WorkingHoursDay[] {
  const stored = rules.length > 0;
  return WEEKDAYS.map(([weekday]) => {
    const windows = rules
      .filter((r) => r.weekday === weekday)
      .sort((a, b) => a.start_minute - b.start_minute)
      .map((r) => ({ start: minutesToTime(r.start_minute), end: minutesToTime(r.end_minute) }));
    return {
      weekday,
      on: stored ? windows.length > 0 : fallbackWeekdays.includes(weekday),
      // An unticked day still carries times, so ticking it needs no further typing
      // and the row has something to dim rather than being empty.
      windows: windows.length > 0 ? windows : [{ ...DEFAULT_DAY }],
    };
  });
}

/** A day's windows as words, or null when it has no readable times yet. */
function windowsPhrase(day: WorkingHoursDay): string | null {
  const parts = day.windows
    .map((w) => {
      const start = formatTimeOfDay(w.start);
      const end = formatTimeOfDay(w.end);
      return start && end ? `${start} to ${end}` : null;
    })
    .filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The words a summary uses, which is all that differs between the two forms. */
interface SummaryWords {
  /** One group of days sharing a window list. */
  group: (days: string, windows: string) => string;
  /** The days nothing is set for, said once at the end. */
  off: (days: string) => string;
  /** Nothing is set at all, which both forms refuse to save. */
  none: string;
}

/**
 * What the week actually is, in one sentence, above the rows.
 *
 * There was no sentence at all before this, so reading your own availability meant
 * opening six dropdowns per day and holding the grid in your head.
 *
 * The grouping key is a day's WHOLE window list rather than one window. A split
 * Monday grouped with the plain Tuesdays would produce "Monday to Friday, 8:00am to
 * 5:00pm", stating hours the agent does not work, which is worse than no sentence.
 *
 * One grouping, two vocabularies: the agent's week says a day is "off" and the org's
 * says it is "closed". Two copies of the grouping would drift the first time either
 * sentence was changed (L41), and the grouping is the part with the trap in it.
 */
function summarize(days: WorkingHoursDay[], words: SummaryWords): string {
  const on = days.filter((d) => d.on);
  const off = days.filter((d) => !d.on).map((d) => d.weekday);

  if (on.length === 0) return words.none;

  const groups = new Map<string, { weekdays: number[]; phrase: string }>();
  for (const day of on) {
    const phrase = windowsPhrase(day) ?? "no times set yet";
    const found = groups.get(phrase);
    if (found) found.weekdays.push(day.weekday);
    else groups.set(phrase, { weekdays: [day.weekday], phrase });
  }

  const sentences = [...groups.values()]
    .sort((a, b) => Math.min(...a.weekdays) - Math.min(...b.weekdays))
    .map((g) =>
      words.group(g.weekdays.length === 7 ? "Every day" : weekdayPhrase(g.weekdays), g.phrase),
    );

  // Nothing is said about days off when there are none, rather than an awkward
  // "No days off" clause on the commonest seven day roster.
  if (off.length > 0) sentences.push(words.off(weekdayPhrase(off)));
  return sentences.join(" ");
}

/** An agent's own week, above the hours rows on /me and the admin's copy. */
export function workingHoursSummary(days: WorkingHoursDay[]): string {
  return summarize(days, {
    group: (d, w) => `${d}, ${w}.`,
    off: (d) => `${d} off.`,
    none: "No working days set. Pick at least one day.",
  });
}

/**
 * The ORG's opening hours, which are a different sentence about the same shape.
 *
 * "Off" is about a person and "closed" is about a business, and this panel sets
 * when leads can be offered a call at all, so it says which days that is.
 */
export function businessHoursSummary(days: WorkingHoursDay[]): string {
  return summarize(days, {
    // Weekday names stay capitalised: they are proper nouns, and lowercasing the
    // phrase to fit after "Open" produces "Open monday to Friday", which reads as a
    // typo on the one screen that says when the business takes calls at all.
    group: (d, w) => `Open ${d}, ${w}.`,
    off: (d) => `Closed ${d}.`,
    none: "Closed every day. Open at least one day, or leads are offered nothing.",
  });
}

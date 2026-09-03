/**
 * Pure: the availability rule rows for an org's default working hours. Used
 * by the daily agents cron to give newly-synced agents a schedule (agents
 * refine on /me later). Exercised by scripts/test-schedule.ts.
 */

/**
 * The seeded working day, in ONE place (#1299).
 *
 * 09:00 used to be written by hand in three spots that have to agree: the org
 * defaults a newly synced agent inherits, the admin form's fallback when the field
 * is left blank, and the smoke seed. Three copies of a number that must match is
 * exactly how a backfill silently reverts, one agent at a time, with nothing to
 * notice it: the roster moves to 08:00 and then the next sync, or the next blank
 * save, quietly writes 09:00 back.
 *
 * The END of the day is deliberately unchanged at 17:00. #1299 moves the start
 * only; where the working day should finish is its own decision with its own
 * evidence, not a side effect of this backfill.
 */
export const SEED_START_MINUTE = 8 * 60;
export const SEED_END_MINUTE = 17 * 60;

/** `minutes from local midnight` as a zero-padded `HH:MM`, the shape an
 *  `<input type="time">` value (and therefore a form fallback) has to take. */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** The same seed day the form falls back to, derived rather than retyped. */
export const SEED_START_TIME = minutesToTime(SEED_START_MINUTE);
export const SEED_END_TIME = minutesToTime(SEED_END_MINUTE);

export interface OrgDefaults {
  default_timezone: string;
  default_start_minute: number;
  default_end_minute: number;
  default_weekdays: number[];
}

// A `type` (not `interface`) so it gains an implicit index signature and stays
// assignable to the Supabase client's insert param (same convention as core.ts).
export type RuleRow = {
  schedule_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
};

export function defaultRuleRows(scheduleId: string, org: OrgDefaults): RuleRow[] {
  if (org.default_end_minute <= org.default_start_minute) return [];
  return org.default_weekdays.map((weekday) => ({
    schedule_id: scheduleId,
    weekday,
    start_minute: org.default_start_minute,
    end_minute: org.default_end_minute,
  }));
}

/** Weekday names by Luxon's numbering (1 = Monday .. 7 = Sunday), so index 0 is
 *  deliberately empty and a 0 weekday reads as blank rather than as Sunday. */
export const WEEKDAY_NAMES = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/**
 * Weekdays as a phrase, collapsing consecutive runs: `Monday to Friday` rather
 * than five names.
 *
 * Two readers, one grouping (#1764). The roster coverage alert needs it because
 * five identical weekday tails are one finding and spelling them out pushes the
 * uncovered Saturday off the bottom of a phone notification; the hours editor needs
 * it to say what a week is in one sentence. A second copy would drift the first time
 * either was changed.
 */
export function weekdayPhrase(weekdays: number[]): string {
  const runs: number[][] = [];
  for (const w of [...weekdays].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && w === last[last.length - 1] + 1) last.push(w);
    else runs.push([w]);
  }
  // A run of one or two contributes its names SEPARATELY rather than pre-joined
  // with "and", or a week off on Tuesday, Thursday, Saturday and Sunday reads
  // "Tuesday, Thursday and Saturday and Sunday": two ands in one clause, because
  // the run had already used the one the final join was going to add.
  const parts = runs.flatMap((run) =>
    run.length >= 3
      ? [`${WEEKDAY_NAMES[run[0]]} to ${WEEKDAY_NAMES[run[run.length - 1]]}`]
      : run.map((w) => WEEKDAY_NAMES[w]),
  );
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

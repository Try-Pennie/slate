import { TimeField } from "@/components/ui/TimeField";
import { labelCls, inputCls, btnCls } from "@/components/ui/styles";
import { minutesToTime } from "@/lib/schedule-core";
import {
  allTimeZones,
  CURATED_ZONES,
  humanizeZone,
  type TimezoneOption,
} from "@/lib/booking/timezones";

/**
 * The zones the picker offers: the curated business zones first, then every zone
 * the runtime knows, and always the agent's CURRENT value so the select can never
 * render blank (which would submit whatever happened to be first and silently move
 * somebody's hours).
 *
 * `allTimeZones()` is guarded and answers [] on a runtime without
 * `Intl.supportedValuesOf`, in which case this degrades to the curated list plus
 * the current value rather than losing the field.
 */
function zoneChoices(current: string): TimezoneOption[] {
  const seen = new Set<string>();
  const out: TimezoneOption[] = [];
  const add = (id: string, label?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: label ?? `${humanizeZone(id)} (${id})` });
  };
  add(current);
  for (const z of CURATED_ZONES) add(z.id, z.label);
  for (const id of allTimeZones().sort()) add(id);
  return out;
}

/** One weekday's row, as the page reads it back from the stored rules. */
export interface WorkingHoursDay {
  weekday: number;
  on: boolean;
  /** "HH:MM" in the agent's own zone. */
  start: string;
  end: string;
  /**
   * This weekday holds MORE than one window in the database (a split shift).
   *
   * The engine honours several windows a day, this form can only express one, and
   * saving replaces every rule for the schedule. So the extra windows would be
   * destroyed by a save the person thought was about something else. The row says
   * so rather than quietly showing the first and swallowing the rest (#1308).
   */
  extraWindows: number;
}

const DAYS: [number, string][] = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [7, "Sunday"],
];

/** The window a day with nothing stored starts on, so ticking a day is one click
 *  and the ordinary case (the same hours all week) is still one edit. */
export const DEFAULT_DAY = { start: minutesToTime(540), end: minutesToTime(1020) };

/**
 * An agent's working hours, a window PER DAY (#1308).
 *
 * One component for both screens that edit these hours, the agent's own and the
 * admin's view of them, because they are the same form with a different subject
 * and two copies would drift the first time one was changed (L41).
 *
 * A row per day rather than a set of checkboxes over one shared window: an agent
 * who works 8 to 4 on Fridays could not say so before, and the engine has always
 * honoured a window per weekday, so any per-day hours written by another route
 * were shown as the first day's and silently overwritten on the next save.
 *
 * Server-rendered on purpose. Every field is a plain input inside a plain form, so
 * it works with no JavaScript, and the refusal comes back from the action rather
 * than from a validator here that would only be a second opinion about the rules
 * `planScheduleReplacement` already owns.
 */
export function WorkingHoursForm({
  action,
  days,
  timezone,
  timezoneLabel,
  userId,
  saveLabel = "Save",
}: {
  action: (form: FormData) => Promise<void>;
  days: WorkingHoursDay[];
  timezone: string;
  timezoneLabel: string;
  /** Present on the admin screen, absent on the agent's own. */
  userId?: string;
  saveLabel?: string;
}) {
  const byDay = new Map(days.map((d) => [d.weekday, d]));

  return (
    <form action={action} className="space-y-4">
      {userId && <input type="hidden" name="user_id" value={userId} />}

      <div>
        <label className={labelCls} htmlFor="hours_timezone">
          {timezoneLabel}
        </label>
        {/* A picker, not free text (#1671). The stored zone drives
            `isWithinWorkingHours`, which compares `rule.weekday !== day.weekday`,
            and a zone Luxon cannot read makes that weekday NaN, so every rule
            misses and the agent is bookable at NO time at all, with their hours
            still rendering correctly afterwards. Typing "Eastern" here used to be
            enough to do that silently. A list makes the broken value
            unrepresentable rather than merely rejected; the server refuses one
            anyway, because a picker is not a validator. */}
        <select
          id="hours_timezone"
          name="timezone"
          aria-label={timezoneLabel}
          defaultValue={timezone}
          className={`${inputCls} w-64`}
        >
          {zoneChoices(timezone).map((z) => (
            <option key={z.id} value={z.id}>
              {z.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        {DAYS.map(([weekday, name]) => {
          const day = byDay.get(weekday);
          const on = day?.on ?? false;
          return (
            <div
              key={weekday}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-md)] border border-border px-4 py-3"
            >
              <label className="flex min-w-[9.5rem] cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  name={`day_${weekday}`}
                  defaultChecked={on}
                  className="h-5 w-5 shrink-0 rounded-[var(--radius-xs)] border-border accent-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
                />
                <span className="text-sm font-semibold">{name}</span>
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <TimeField
                  name={`start_${weekday}`}
                  ariaLabel={`${name} start time`}
                  defaultValue={day?.start ?? DEFAULT_DAY.start}
                />
                <span aria-hidden="true" className="text-sm text-fg-muted">
                  to
                </span>
                <TimeField
                  name={`end_${weekday}`}
                  ariaLabel={`${name} end time`}
                  round="up"
                  defaultValue={day?.end ?? DEFAULT_DAY.end}
                />
              </div>

              {day && day.extraWindows > 0 && (
                <p className="min-w-[14rem] flex-1 text-xs text-error">
                  {name} has {day.extraWindows === 1 ? "another window" : `${day.extraWindows} more windows`}{" "}
                  set that this form cannot show. Saving replaces{" "}
                  {day.extraWindows === 1 ? "it" : "them"} with the single window above.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <button className={btnCls}>{saveLabel}</button>
    </form>
  );
}

/**
 * The stored rules as the form reads them: one row per weekday, its own times, and
 * a count of any extra windows that row cannot represent.
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
  return DAYS.map(([weekday]) => {
    const forDay = rules
      .filter((r) => r.weekday === weekday)
      .sort((a, b) => a.start_minute - b.start_minute);
    const first = forDay[0];
    return {
      weekday,
      on: stored ? forDay.length > 0 : fallbackWeekdays.includes(weekday),
      start: first ? minutesToTime(first.start_minute) : DEFAULT_DAY.start,
      end: first ? minutesToTime(first.end_minute) : DEFAULT_DAY.end,
      extraWindows: Math.max(0, forDay.length - 1),
    };
  });
}

import { WorkingHoursWeek } from "@/components/ui/WorkingHoursWeek";
import { labelCls, inputCls } from "@/components/ui/styles";
import type { WorkingHoursDay } from "@/lib/schedule-week";
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

/**
 * An agent's working hours: a week of typed times, several windows a day (#1764).
 *
 * One component for both screens that edit these hours, the agent's own and the
 * admin's view of them, because they are the same form with a different subject and
 * two copies would drift the first time one was changed (L41).
 *
 * This half stays on the server, and it is only the shell: the form element, the
 * subject, and the zone list. The zone list is the reason for the split, since it
 * runs to several hundred options and is built from `Intl.supportedValuesOf`, whose
 * answer can differ between the runtime that renders and the browser that hydrates.
 * Resolving it once here keeps that out of the interactive part entirely.
 *
 * **It needs JavaScript, and the times always did.** This docstring used to claim
 * the form was "server-rendered on purpose. Every field is a plain input inside a
 * plain form, so it works with no JavaScript". That was true of the checkboxes and
 * the timezone select and never true of the times: `TimeField` has always been a
 * client component whose hidden input is React controlled, so with JavaScript off
 * the times submitted their initial values. The typeahead, `+` and `x` need
 * scripting too, so nothing is lost, but the claim is gone rather than left
 * standing as a guarantee nobody could rely on.
 *
 * The refusals that MATTER still come from the server. `planScheduleReplacement`
 * owns whether a week can be saved (overlapping windows, a day with no times, an
 * unreadable zone), because the write deletes every rule for the schedule before
 * reinserting, so a bad input silently removes an agent from every bucket. What the
 * fields refuse locally is narrower and different in kind: a value that is not a
 * time at all, which the server would only ever see as NaN.
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
  return (
    <form action={action} className="space-y-4">
      {userId && <input type="hidden" name="user_id" value={userId} />}

      <WorkingHoursWeek
        days={days}
        saveLabel={saveLabel}
        timezoneField={
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
        }
      />
    </form>
  );
}

import { WorkingHoursWeek } from "@/components/ui/WorkingHoursWeek";
import { labelCls } from "@/components/ui/styles";
import { SelectField } from "@/components/ui/SelectField";
import type { WorkingHoursDay } from "@/lib/schedule-week";
import { timezoneOptions, resolveZone } from "@/lib/booking/timezones";

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
  defaultsAction,
  companyDefaultDays,
}: {
  action: (form: FormData) => Promise<void>;
  days: WorkingHoursDay[];
  timezone: string;
  timezoneLabel: string;
  /** Present on the admin screen, absent on the agent's own. */
  userId?: string;
  saveLabel?: string;
  /** Replace this week with the company default (#1873). Admin screen only, and
   *  it submits THIS form to a second action so it can see unsaved edits. */
  defaultsAction?: (form: FormData) => Promise<void>;
  /** The week that action would write, so the confirm names what it replaces. */
  companyDefaultDays?: WorkingHoursDay[];
}) {
  return (
    <form action={action} className="space-y-4">
      {userId && <input type="hidden" name="user_id" value={userId} />}

      <WorkingHoursWeek
        days={days}
        saveLabel={saveLabel}
        defaultsAction={defaultsAction}
        companyDefaultDays={companyDefaultDays}
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
{/* #1849: a fixed US list in a picker of our own. It used to be the
                curated zones plus every zone the runtime knows, several hundred
                rows, in a menu the platform drew and our CSS could not bound, so
                it covered the whole window.

                `resolveZone` is what stops the old failure mode coming back in a
                new form: a stored zone the list cannot show resolves to a named
                default rather than leaving the control blank or landing on
                whatever is first, either of which moves somebody's hours without
                telling them. The roster was migrated to the list before this
                shipped, so today nothing resolves. */}
            <SelectField
              id="hours_timezone"
              name="timezone"
              ariaLabel={timezoneLabel}
              defaultValue={resolveZone(timezone).id}
              className="w-64"
              options={timezoneOptions().map((z) => ({ value: z.id, label: z.label }))}
            />
          </div>
        }
      />
    </form>
  );
}

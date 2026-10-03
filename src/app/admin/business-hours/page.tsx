import { redirect } from "next/navigation";
import { SaveForm } from "@/components/ui/SaveForm";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  setBusinessHours,
  setBusinessHoursException,
  removeBusinessHoursException,
  setBookingHorizon,
  setOrgDefaultHours,
} from "@/app/admin/actions";
import {
  loadBusinessHoursRows,
  loadBusinessHoursExceptions,
} from "@/lib/booking/business-hours-load";
import {
  BUSINESS_ZONE,
  SEEDED_BUSINESS_HOURS,
  type BusinessHoursException,
} from "@/lib/booking/business-hours";
import { coverageForWeek, type CoverageReadout } from "@/lib/booking/business-hours-coverage";
import {
  loadCoverageAgents,
  currentWeekStartIso,
} from "@/lib/booking/business-hours-coverage-load";
import { minutesToTime } from "@/lib/schedule-core";
import { humanizeZone } from "@/lib/booking/timezones";
import { BusinessHoursForm, type BusinessHoursDay } from "@/components/ui/BusinessHoursForm";
import { BusinessHoursExceptions } from "@/components/ui/BusinessHoursExceptions";
import {
  HORIZON_DEFAULT,
  HORIZON_MIN,
  HORIZON_MAX,
  readPublicBookingPaused,
} from "@/lib/booking/settings";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { DayToggles } from "@/components/ui/DayToggles";
import { TimeField } from "@/components/ui/TimeField";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { log } from "@/lib/log";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { PublicBookingSwitch } from "@/components/admin/PublicBookingSwitch";
import { btnCls, cardCls, inputCls, labelCls, proseCls } from "@/components/ui/styles";
import { OFFERED_OPEN_DAYS } from "@/lib/availability/bookable-days";

export const metadata = { title: "Hours" };

export const dynamic = "force-dynamic";

/** The org's seeding template for a newly added agent (#1892, moved here). */
type OrgDefaults = {
  default_timezone: string;
  default_start_minute: number;
  default_end_minute: number;
  default_weekdays: number[];
};

export default async function BusinessHoursPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const saved = savedSentence(savedOutcome(sp.ok));
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;

  // could-not-measure state there was, `coverage = { ok: false }`, whose wording
  // names the ROSTER. A failed WEEK read therefore drew seven unchecked weekdays
  // (this page stating Pennie is closed every day, on the screen whose job is to
  // say what the hours are) beside a notice blaming a read that may have been
  // perfectly fine, and a failed EXCEPTIONS read drew "No dates are set", a
  // categorical all clear about holiday closures produced by a read that never
  // ran. Distinct causes get distinct messages (L11), and a surface derived from
  // several reads gates on every one of them (L530).
  //
  // `null` is the unreadable state throughout, never an empty value: an empty
  // week and an empty exception list are both legitimate readings, and both are
  // the reassuring one.
  // The booking horizon sits with the hours: both decide which times exist at
  // all, and separating them puts two halves of one answer on two screens.
  let horizonDays: number | null = null;
  try {
    const settings = await supabaseAdmin()
      .from("booking_settings")
      .select("horizon_days")
      .eq("id", 1)
      .maybeSingle();
    if (!settings.error && settings.data) {
      horizonDays = (settings.data as { horizon_days: number | null }).horizon_days;
    }
  } catch {
    // Fall through to the built-in default shown as a placeholder.
  }

  // #2297: the kill switch's current state. Its OWN read, resolving to null when it
  // fails, because "we could not read whether bookings are running" is a different
  // screen from either answer and the page must not draw one of them instead (L530).
  const publicBookingPaused = await readPublicBookingPaused();

  const db = supabaseAdmin();
  // #1892: the org's DEFAULT hours for a new agent ARE read here now, because
  // this page draws them. The comment that stood here said they were a different
  // subject on a different route, which described the arrangement being replaced.
  //
  // It does not reverse #1748's reasoning. That cost was loading reads a page does
  // not draw; all four of these are drawn. And it moves back toward #1297's own
  // stated intent, which was to name them apart and place them adjacent so the
  // difference is the first thing read.
  //
  // FOUR reads means four could-not-measure states, not one (L530). Each resolves
  // to `null` on failure, never to an empty value, because an empty week, an empty
  // exception list and an empty set of defaults are all legitimate readings and all
  // of them are the reassuring one (#1651, #1530).
  const [weekRead, exceptionsRead, agentsRead, orgRead] = await Promise.allSettled([
    loadBusinessHoursRows(),
    // #1363: the dates that override the weekly pattern. Read here rather than
    // inside the component so the page, not the component, owns the failure.
    loadBusinessHoursExceptions(
      DateTime.now().setZone(BUSINESS_ZONE).toISODate() ?? "1970-01-01",
    ),
    // The pool and their rules, through the SAME loader the monitor lane's
    // roster-coverage alarm uses (#1454), so the screen and the alarm can never
    // disagree about who covers what. It THROWS rather than returning empty:
    // rendering an unreadable roster as "nobody covers this" reads as a staffing
    // problem someone would go and fix.
    loadCoverageAgents(db),
    // The new agent seeding template. Its own read, so an unreadable one says so
    // in its own words rather than emptying a neighbouring panel.
    (async () => {
      const read = await db
        .from("organizations")
        .select("default_timezone, default_start_minute, default_end_minute, default_weekdays")
        .eq("id", me.org_id)
        .maybeSingle();
      if (read.error) throw read.error;
      return read.data as OrgDefaults | null;
    })(),
  ]);

  let businessDays: BusinessHoursDay[] | null = null;
  if (weekRead.status === "fulfilled") {
    // An unconfigured table resolves to the seeded week, matching what the gate
    // itself would use, so the editor never shows a blank week that saving would
    // then make real. That is a READ that succeeded and found nothing, which is a
    // different thing from a read that failed.
    const week =
      weekRead.value.length === 7
        ? weekRead.value
        : SEEDED_BUSINESS_HOURS.map((r) => ({ ...r, is_open: true })).concat(
            [7].map((weekday) => ({ weekday, is_open: false, start_minute: 480, end_minute: 1200 })),
          );
    businessDays = [...week]
      .sort((a, b) => a.weekday - b.weekday)
      .map((r) => ({
        weekday: r.weekday,
        is_open: r.is_open,
        start: minutesToTime(r.start_minute),
        end: minutesToTime(r.end_minute),
      }));
  } else {
    log.error("admin-settings", { msg: "business hours week unreadable" }, weekRead.reason);
  }

  let exceptions: BusinessHoursException[] | null = null;
  if (exceptionsRead.status === "fulfilled") {
    exceptions = exceptionsRead.value;
  } else {
    log.error("admin-settings", { msg: "business hours exceptions unreadable" }, exceptionsRead.reason);
  }

  // #1651: binding `error` satisfies the swallowed-read scanner, but its only
  // consequence used to be `org = null`, and the section renders behind
  // `{org && …}`, so the whole panel vanished with nothing said. An absent panel
  // is indistinguishable from a page that never had one.
  let coverage: CoverageReadout = { ok: false };
  if (agentsRead.status === "fulfilled" && businessDays) {
    coverage = coverageForWeek({
      businessHours: businessDays.map((d) => ({
        weekday: d.weekday,
        is_open: d.is_open,
        start_minute: Number(d.start.slice(0, 2)) * 60 + Number(d.start.slice(3, 5)),
        end_minute: Number(d.end.slice(0, 2)) * 60 + Number(d.end.slice(3, 5)),
      })),
      zone: BUSINESS_ZONE,
      agents: agentsRead.value,
      weekStartIso: currentWeekStartIso(),
    });
  } else if (agentsRead.status === "rejected") {
    log.error("admin-settings", { msg: "coverage roster unreadable" }, agentsRead.reason);
  }

  let orgDefaults: OrgDefaults | null = null;
  if (orgRead.status === "fulfilled") {
    orgDefaults = orgRead.value;
  } else {
    log.error("admin-settings", { msg: "org defaults unreadable" }, orgRead.reason);
  }

  return (
    <>
      {/* #1892: "Hours", not "Business hours". The page holds the org's real
          operating window, the holiday closures, the booking horizon AND the new
          agent template, so naming it for the last of those would be wrong, and
          the org's own hours reading as a "default" is exactly the confusion
          #1297 was written about. Dan chose Hours on 2026-09-04. */}
      <AdminPageHeader title="Hours">
        Whether Slate is taking bookings at all, when Pennie is open, the holidays and
        closures on top of that, how far ahead a lead can book, and what a new agent
        starts on. Every offered time is judged against the business hours, so a change
        there moves the whole roster.
      </AdminPageHeader>
      {/* #1990: the sentence comes from the OUTCOME, so it names the form
          that saved rather than whatever this page had written down. An
          unrecognised value (a bookmarked `?ok=1` from before outcomes were
          named) shows nothing, rather than confirming a save nobody made. */}
      {saved && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
      {sp.error && !saved && <SettingsSaveNotice ok={false} error={sp.error} saved="" />}
      {/* #2297: first, because it is the one thing on this page somebody needs in
          an emergency, and the only one that is read rather than edited on an
          ordinary day. Quiet while bookings are running; the stopped state is the
          loud one. */}
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Online booking</h2>
        <p className={`mb-4 ${proseCls} text-xs text-fg-muted`}>
          Whether leads can book a call at all. Stopping it takes effect on the next
          booking anyone tries, with no deploy, and leaves availability, calendar
          syncing and existing bookings alone.
        </p>
        <PublicBookingSwitch paused={publicBookingPaused} />
      </section>
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Business hours</h2>
        <p className={`mb-4 ${proseCls} text-xs text-fg-muted`}>
          When Pennie is open. No lead is offered a time outside these hours, on any
          bucket, whatever an agent&apos;s own schedule says. A change applies to
          everyone straight away.
        </p>
        {businessDays ? (
          <BusinessHoursForm
            action={setBusinessHours}
            days={businessDays}
            zoneLabel={humanizeZone(BUSINESS_ZONE)}
            coverage={coverage}
          />
        ) : (
          <UnreadableNotice>
            The hours for the week could not be read just now, so this is not saying
            Pennie is closed. Reload in a moment. The hours themselves are unchanged
            and the booker is still using them.
          </UnreadableNotice>
        )}
      </section>
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Specific dates</h2>
        <p className={`mb-4 ${proseCls} text-xs text-fg-muted`}>
          Dates that do not follow the weekly pattern above: a holiday shutdown, or
          a one off day open when Pennie normally is not. A closed date is offered
          to nobody, and the booker tells a lead we are closed and when we are back
          rather than that every time is taken. Appointments already in the diary
          stay put.
        </p>
        {exceptions ? (
          <BusinessHoursExceptions
            action={setBusinessHoursException}
            removeAction={removeBusinessHoursException}
            exceptions={exceptions}
            zoneLabel={humanizeZone(BUSINESS_ZONE)}
          />
        ) : (
          <UnreadableNotice>
            The dates that override the weekly pattern could not be read just now, so
            this is not saying there are none. Reload in a moment. Any dates already
            set are unchanged and the booker is still honouring them.
          </UnreadableNotice>
        )}
      </section>
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Days offered</h2>
        <p className={`mb-4 ${proseCls} text-xs text-fg-muted`}>
          A lead is offered the next {OFFERED_OPEN_DAYS} days the business is open,
          and a lower tier before a later day. Only when every tier they may use is
          full for those days are later days offered. This number is how far that
          can reach, counted from today in days that actually have times, so a
          closed day does not use one up: with Sundays closed, four days can reach
          into the following week. Applies to every bucket. A change refreshes
          availability across all buckets within a minute or two.
        </p>
        <SaveForm action={setBookingHorizon} name="booking-horizon" unsaved="changes to the booking window" className="space-y-4">
          <div>
            {/* heading-gloss-ok: the accepted RANGE of the number, derived from the same
                  constants the server validates against. */}
            <label className={labelCls} htmlFor="horizon_days">
              Most days offered ({HORIZON_MIN} to {HORIZON_MAX})
            </label>
            {/* #1924: pre-filled with the real default, not a placeholder. A
                required field that loads EMPTY forces an admin to type a number
                nobody chose, and the grey placeholder looked enough like a value
                to be mistaken for one, which is how a save wrote null. The value
                is real now, so a placeholder would say the same thing twice and
                is gone. `required` is a courtesy that saves a round trip;
                `parseHorizonForm` is still the control. */}
            <input
              type="number"
              inputMode="numeric"
              id="horizon_days"
              name="horizon_days"
              min={HORIZON_MIN}
              max={HORIZON_MAX}
              step={1}
              required
              defaultValue={horizonDays ?? HORIZON_DEFAULT}
              className={`${inputCls} w-40 tabular-nums`}
            />
          </div>
          <SubmitButton className={btnCls} pendingLabel="Saving…">
            Save booking horizon
          </SubmitButton>
        </SaveForm>
      </section>

      {/* #1892: the new agent template, moved from its own route.
          #1297 named the risk this creates: business hours and the seeding
          template both look like "hours in a settings screen", and confusing them
          silently moves the whole roster's bookability. Putting them on one page
          reduces the separation, so the distinction is carried by STRUCTURE
          instead: the org window is first, this is last, they are separate cards
          with separate save buttons, and the headings cannot be misread for each
          other. */}
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">New agent starting hours</h2>
        {orgDefaults === null ? (
          <UnreadableNotice className="mt-3">
            The starting hours for a new agent could not be read just now, so nothing is
            shown here. Reload in a moment. The stored defaults are unchanged, and
            adding an agent still applies them.
          </UnreadableNotice>
        ) : (
          <>
            <p className={`mb-4 ${proseCls} text-xs text-fg-muted`}>
              What a new agent starts with. Existing agents are not changed.
            </p>
            <SaveForm action={setOrgDefaultHours} name="org-default-hours" unsaved="changes to the default hours" className="flex flex-wrap items-end gap-3">
              <div>
                <label className={labelCls} htmlFor="default_timezone">
                  Timezone
                </label>
                <input
                  id="default_timezone"
                  name="default_timezone"
                  defaultValue={orgDefaults.default_timezone}
                  className={`${inputCls} w-44`}
                />
              </div>
              <div>
                <span className={labelCls}>Days</span>
                <div className="mt-1">
                  <DayToggles
                    namePrefix="dday_"
                    isOn={(d) => orgDefaults.default_weekdays.includes(d)}
                  />
                </div>
              </div>
              <div>
                <span className={labelCls}>Start</span>
                <TimeField
                  name="default_start"
                  ariaLabel="New agent start time"
                  defaultValue={minutesToTime(orgDefaults.default_start_minute)}
                  className="mt-1"
                  enforce
                />
              </div>
              <div>
                <span className={labelCls}>End</span>
                <TimeField
                  name="default_end"
                  ariaLabel="New agent end time"
                  round="up"
                  defaultValue={minutesToTime(orgDefaults.default_end_minute)}
                  className="mt-1"
                  enforce
                />
              </div>
              <SubmitButton className={btnCls} pendingLabel="Saving…">
                Save starting hours
              </SubmitButton>
            </SaveForm>
          </>
        )}
      </section>
    </>
  );
}

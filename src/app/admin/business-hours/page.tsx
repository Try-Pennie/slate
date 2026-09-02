import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  setBusinessHours,
  setBusinessHoursException,
  removeBusinessHoursException,
  setBookingHorizon,
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
import { HORIZON_DEFAULT, HORIZON_MIN, HORIZON_MAX } from "@/lib/booking/settings";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { log } from "@/lib/log";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { btnCls, cardCls, inputCls, labelCls } from "@/components/ui/styles";

export const dynamic = "force-dynamic";

export default async function BusinessHoursPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");

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

  const db = supabaseAdmin();
  // The org's DEFAULT hours for a new agent are not read here: they are a
  // different subject on a different route (/admin/default-hours), and #1297 put
  // them next to these only because both looked like "hours in a settings screen".
  const [weekRead, exceptionsRead, agentsRead] = await Promise.allSettled([
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

  return (
    <>
      <AdminPageHeader title="Business hours">
        When Pennie is open, the holidays and closures on top of that, and how far
        ahead a lead can book. Every offered time is judged against these first, so
        a change here moves the whole roster.
      </AdminPageHeader>
      <SettingsSaveNotice ok={!!sp.ok} error={sp.error} />
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Business hours</h2>
        <p className="mb-4 max-w-prose text-xs text-fg-muted">
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
        <p className="mb-4 max-w-prose text-xs text-fg-muted">
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
        <p className="mb-4 max-w-prose text-xs text-fg-muted">
          How many days a lead is offered to choose from. Counted in days that
          actually have times, so a closed day does not use one up: with Sundays
          closed, four days can reach into the following week. Applies to every
          bucket. Leave blank to use the default ({HORIZON_DEFAULT}). A change
          refreshes availability across all buckets within a minute or two.
        </p>
        <form action={setBookingHorizon} className="space-y-4">
          <div>
            <label className={labelCls} htmlFor="horizon_days">
              Days offered ({HORIZON_MIN} to {HORIZON_MAX})
            </label>
            <input
              type="number"
              inputMode="numeric"
              id="horizon_days"
              name="horizon_days"
              min={HORIZON_MIN}
              max={HORIZON_MAX}
              step={1}
              defaultValue={horizonDays ?? ""}
              placeholder={String(HORIZON_DEFAULT)}
              className={`${inputCls} w-40 tabular-nums`}
            />
          </div>
          <SubmitButton className={btnCls} pendingLabel="Saving…">
            Save booking horizon
          </SubmitButton>
        </form>
      </section>
    </>
  );
}

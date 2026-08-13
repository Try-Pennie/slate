import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  setMonitorSettings,
  setDefaultBucket,
  setBookingHorizon,
  setEventDescription,
  setBusinessHours,
  setOrgDefaultHours,
} from "@/app/admin/actions";
import { loadBusinessHoursRows } from "@/lib/booking/business-hours-load";
import { BUSINESS_ZONE, SEEDED_BUSINESS_HOURS } from "@/lib/booking/business-hours";
import { coverageForWeek, type CoverageReadout } from "@/lib/booking/business-hours-coverage";
import {
  loadCoverageAgents,
  currentWeekStartIso,
} from "@/lib/booking/business-hours-coverage-load";
import { minutesToTime } from "@/lib/schedule-core";
import { humanizeZone } from "@/lib/booking/timezones";
import { BusinessHoursForm, type BusinessHoursDay } from "@/components/ui/BusinessHoursForm";
import { DayToggles } from "@/components/ui/DayToggles";
import { TimeField } from "@/components/ui/TimeField";
import {
  HORIZON_DEFAULT,
  HORIZON_MIN,
  HORIZON_MAX,
  EVENT_DESCRIPTION_MAX,
} from "@/lib/booking/settings";
import {
  ALERT_FIELDS as COOLDOWN_FIELDS,
  MONITOR_DEFAULTS,
  quietedAlarms,
  formatMinutes,
  resolveLowVolumeArmed,
  resolveFailureRateArmed,
  resolveAvailabilityDriftArmed,
  resolveRosterCoverageArmed,
  envLowVolumeArmed,
} from "@/lib/monitor/settings";
import { AppHeader } from "@/components/AppHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { SettingsSaveNotice } from "./SettingsSaveNotice";
import { labelCls, inputCls, cardCls, btnCls } from "@/components/ui/styles";
import type { MonitorAlertConfig, MonitorSettings, User } from "@/lib/db/types";

export const dynamic = "force-dynamic";

/** A short "changed" date for the quieted-alarm list, e.g. "Aug 5". */
function shortStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "at an unknown time";
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric" });
}

/** Formats a stored/updated pair into "changed by X at Y", or a default note. */
function lastChangedLine(
  latest: { updated_at: string; updated_by: string | null } | null,
  nameById: Map<string, string>,
): string {
  if (!latest) return "Never changed; using built-in defaults.";
  const who = latest.updated_by ? (nameById.get(latest.updated_by) ?? "someone") : "someone";
  const when = new Date(latest.updated_at).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `Last changed by ${who} at ${when}.`;
}

export default async function MonitorSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need an admin account to change alert settings.
      </main>
    );
  }

  // Read stored values to prefill. Guarded: the tables may not exist yet during
  // a migrate-before-deploy window, and a missing table must not 500 the page.
  let rows: MonitorSettings[] = [];
  let config: MonitorAlertConfig | null = null;
  try {
    const db = supabaseAdmin();
    const [cooldowns, cfg] = await Promise.all([
      db.from("monitor_settings").select("*"),
      db.from("monitor_alert_config").select("*").eq("id", 1).maybeSingle(),
    ]);
    if (!cooldowns.error && cooldowns.data) rows = cooldowns.data as MonitorSettings[];
    if (!cfg.error && cfg.data) config = cfg.data as MonitorAlertConfig;
  } catch {
    // Fall through to empty (defaults shown as placeholders).
  }

  // #575: default the arm toggle to the EFFECTIVE state (store > env > disarmed),
  // not just the stored column, so an admin on an env-armed deploy who saves other
  // changes can't silently disarm the alert by leaving a falsely-unchecked box.
  const lowVolumeArmed = resolveLowVolumeArmed(config, envLowVolumeArmed());
  const failureRateArmed = resolveFailureRateArmed(config);
  const availabilityDriftArmed = resolveAvailabilityDriftArmed(config);
  const rosterCoverageArmed = resolveRosterCoverageArmed(config);

  const storedByKey = new Map(rows.map((r) => [r.key, r.cooldown_min]));
  // #1289: every alarm currently quieter than its coded default. Read through the
  // same resolver the alerts use, so a stored value the resolver discards (a 0, a
  // negative) is never reported as quieting anything.
  const quieted = quietedAlarms(rows);

  // Resolve updated_by ids to names for the "last changed" line.
  const editorIds = [...new Set([...rows.map((r) => r.updated_by), config?.updated_by ?? null].filter(Boolean))] as string[];
  const nameById = new Map<string, string>();
  if (editorIds.length) {
    const { data } = await supabaseAdmin().from("users").select("id, name, email").in("id", editorIds);
    for (const u of (data ?? []) as Pick<User, "id" | "name" | "email">[]) {
      nameById.set(u.id, u.name ?? u.email);
    }
  }
  const stamps = [...rows, ...(config ? [config] : [])]
    .map((r) => ({ updated_at: r.updated_at, updated_by: r.updated_by }))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const lastChanged = lastChangedLine(stamps[0] ?? null, nameById);

  // Direct-booking default bucket (#1016). Read the current default + the list of
  // non-test bucket codes to offer. Guarded so a missing table (migrate-before-
  // deploy window) shows an empty picker instead of 500ing the whole page.
  let defaultBucketCode: string | null = null;
  let horizonDays: number | null = null;
  let bucketOptions: { code: string; name: string }[] = [];
  // #1335: the event types whose lead-facing description is editable here. Same
  // guarded read as its neighbours, so a missing table shows an empty editor rather
  // than 500ing the whole settings page.
  let eventTypes: { id: string; name: string; description: string | null }[] = [];
  try {
    const db = supabaseAdmin();
    const [settings, buckets, types] = await Promise.all([
      db.from("booking_settings").select("default_bucket_code, horizon_days").eq("id", 1).maybeSingle(),
      db.from("buckets").select("code, name").eq("is_test", false).order("code"),
      // cap-safe: event_types is roster-bounded config (one per offering), a fixed
      // handful of rows that can never fill a page.
      db.from("event_types").select("id, name, description").order("created_at"),
    ]);
    if (!settings.error && settings.data) {
      const row = settings.data as { default_bucket_code: string | null; horizon_days: number | null };
      defaultBucketCode = row.default_bucket_code;
      horizonDays = row.horizon_days;
    }
    if (!buckets.error && buckets.data) {
      bucketOptions = buckets.data as { code: string; name: string }[];
    }
    if (!types.error && types.data) {
      eventTypes = types.data as { id: string; name: string; description: string | null }[];
    }
  } catch {
    // Fall through to no default / empty options.
  }

  // --- Business hours (#1297) -------------------------------------------------
  // The raw week (including closed days and their kept windows), the org's own
  // seeding defaults, and who is actually rostered inside the open hours.
  //
  // The roster read THROWS on failure rather than returning empty, and that has to
  // survive to the screen: rendering an unreadable roster as "nobody covers this"
  // reads as a staffing problem someone would go and fix. So a failure becomes the
  // could-not-check state, never a zero.
  let businessDays: BusinessHoursDay[] = [];
  let coverage: CoverageReadout = { ok: false };
  type OrgDefaults = {
    default_timezone: string;
    default_start_minute: number;
    default_end_minute: number;
    default_weekdays: number[];
  };
  let org: OrgDefaults | null = null;
  try {
    const db = supabaseAdmin();
    const [rowsRaw, orgRes] = await Promise.all([
      loadBusinessHoursRows(),
      db
        .from("organizations")
        .select("default_timezone, default_start_minute, default_end_minute, default_weekdays")
        .eq("id", me.org_id)
        .maybeSingle(),
    ]);
    // An unconfigured table resolves to the seeded week, matching what the gate
    // itself would use, so the editor never shows a blank week that saving would
    // then make real.
    const week =
      rowsRaw.length === 7
        ? rowsRaw
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
    if (!orgRes.error && orgRes.data) {
      org = orgRes.data as OrgDefaults;
    }

    // The pool and their rules, through the SAME loader the monitor lane's
    // roster-coverage alarm uses (#1454), so the screen and the alarm can never
    // disagree about who covers what.
    const agents = await loadCoverageAgents(db);

    coverage = coverageForWeek({
      businessHours: businessDays.map((d) => ({
        weekday: d.weekday,
        is_open: d.is_open,
        start_minute: Number(d.start.slice(0, 2)) * 60 + Number(d.start.slice(3, 5)),
        end_minute: Number(d.end.slice(0, 2)) * 60 + Number(d.end.slice(3, 5)),
      })),
      zone: BUSINESS_ZONE,
      agents,
      weekStartIso: currentWeekStartIso(),
    });
  } catch {
    // Any of those reads failing leaves coverage in its could-not-check state and
    // the week on the seeded default, which is what the gate would serve anyway.
    coverage = { ok: false };
  }

  const armed = process.env.BOOKING_VOLUME_ALERT_ARMED === "1";
  const envAlerts = process.env.SLACK_ALERTS_CHANNEL ?? "";
  const envInfo = process.env.SLACK_INFO_CHANNEL ?? "";

  return (
    <>
      <AppHeader
        email={me.email}
        role={me.role}
        active="admin"
        themePreference={me.theme_preference}
        userId={me.id}
        orgId={me.org_id}
        bookable={me.bookable}
        avatarUrl={me.avatar_url}
      />
      <main className="mx-auto w-full min-w-0 max-w-3xl space-y-8 px-6 py-10 sm:px-8">
        <section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">
          <p className="pn-eyebrow text-pennie-sky">Admin</p>
          <h1 className="text-2xl font-semibold text-white dark:text-fg">Booking and alert settings</h1>
          <p className="mt-2 max-w-prose text-sm text-white/80 dark:text-fg-muted">
            When Pennie is open, how far ahead leads can book, and how the monitor
            alerts behave, all without a deploy. Leave an alert field blank to use its
            built-in default. Cooldowns are in minutes; floors are booking counts.
          </p>
          <p className="mt-3 text-xs text-white/70 dark:text-fg-muted">{lastChanged}</p>
        </section>

        <SettingsSaveNotice ok={!!sp.ok} error={sp.error} />
        {!armed && (
          <div className="rounded-md border border-border bg-[var(--bg-alt)] px-5 py-4 text-sm text-fg-muted">
            Heads up: the low-booking-volume alarm is currently <strong>disarmed</strong> (a
            deploy-time setting). Tuning its floors below has no effect until it is armed.
          </div>
        )}

        {/* #1289: an alarm quieted for a good reason is indistinguishable from an
            alarm that was always quiet, and the stored number alone does not say
            which it is. This names every one that repeats less often than the code
            intends, with the default beside it and when it changed. */}
        {/* Same neutral card as the disarmed-alarm notice above it: the design
            system keeps yellow and peach for illustration and rose for errors, and
            this is neither, so it reads in the same voice as its neighbour rather
            than inventing a warning colour the system does not have. */}
        {quieted.length > 0 && (
          <div className="rounded-md border border-border bg-[var(--bg-alt)] px-5 py-4">
            <p className="text-sm font-semibold text-fg">
              {quieted.length === 1
                ? "1 alarm is set to repeat less often than its default"
                : `${quieted.length} alarms are set to repeat less often than their defaults`}
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              Deliberate while the routing pool is off. Each one needs putting back
              before real booking traffic arrives: clear the field below to fall back
              to the default.
            </p>
            <ul className="mt-3 space-y-2">
              {quieted.map((q) => (
                <li key={q.key} data-quieted-alarm={q.key} className="text-xs text-fg">
                  <span className="font-semibold">{q.label}</span>
                  <span className="tabular-nums text-fg-muted">
                    {" "}
                    is set to {formatMinutes(q.storedMinutes)}, against a default of{" "}
                    {formatMinutes(q.defaultMinutes)}
                    {q.updatedAt ? `, changed ${shortStamp(q.updatedAt)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <form action={setMonitorSettings} className="space-y-8">
          <section className={cardCls}>
            <h2 className="mb-1 text-sm font-semibold">Alert cooldowns (minutes)</h2>
            <p className="mb-4 text-xs text-fg-muted">
              The minimum time between repeats of the same alert.
            </p>
            <div className="space-y-4">
              {COOLDOWN_FIELDS.map((f) => {
                const stored = storedByKey.get(f.key);
                const defMin = MONITOR_DEFAULTS.cooldownMs[f.key] / 60_000;
                return (
                  <div key={f.key}>
                    <label className={labelCls} htmlFor={`cooldown_${f.key}`}>
                      {f.label}
                    </label>
                    <input
                      id={`cooldown_${f.key}`}
                      name={`cooldown_${f.key}`}
                      type="number"
                      min={1}
                      inputMode="numeric"
                      defaultValue={stored ?? ""}
                      placeholder={`default ${defMin} min`}
                      className={`${inputCls} w-48 tabular-nums`}
                    />
                    <p className="mt-1 text-xs text-fg-muted">
                      {f.help}{" "}
                      <span className="tabular-nums">
                        Default {formatMinutes(defMin)}
                        {stored != null && stored > defMin
                          ? `; currently ${formatMinutes(stored)}, so it repeats less often than intended.`
                          : "."}
                      </span>
                    </p>
                  </div>
                );
              })}
            </div>
          </section>

          <section className={cardCls}>
            <h2 className="mb-1 text-sm font-semibold">Low-volume floors (booking counts)</h2>
            <p className="mb-4 text-xs text-fg-muted">
              Expected minimum bookings in each window; below the floor triggers the
              low-volume alert (when armed).
            </p>
            <div className="flex flex-wrap gap-6">
              <div>
                <label className={labelCls} htmlFor="floor_30">
                  Floor (last 30 min)
                </label>
                <input
                  id="floor_30"
                  name="floor_30"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  defaultValue={config?.floor_30 ?? ""}
                  placeholder={`default ${MONITOR_DEFAULTS.floor30}`}
                  className={`${inputCls} w-40 tabular-nums`}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="floor_120">
                  Floor (last 120 min)
                </label>
                <input
                  id="floor_120"
                  name="floor_120"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  defaultValue={config?.floor_120 ?? ""}
                  placeholder={`default ${MONITOR_DEFAULTS.floor120}`}
                  className={`${inputCls} w-40 tabular-nums`}
                />
              </div>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="low_volume_armed"
                value="on"
                defaultChecked={lowVolumeArmed}
                className="h-4 w-4"
              />
              Send a Slack alert when bookings drop off
            </label>
            <p className="mt-1 text-xs text-fg-muted">
              Off: Slate still counts bookings, but nobody is notified. On: Slack gets an
              alert when bookings fall below the floors set above. Leave this off during
              the ramp and turn it on once Slate owns roughly full booking traffic.
              Saving applies immediately, no deploy needed.
            </p>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="failure_rate_armed"
                value="on"
                defaultChecked={failureRateArmed}
                className="h-4 w-4"
              />
              Send a Slack alert when customers are failing to book
            </label>
            <p className="mt-1 text-xs text-fg-muted">
              Off: Slate still checks every 5 minutes and records what it finds in the
              logs, but nobody is notified. On: Slack gets an alert when too many booking
              attempts fail over the last hour, and a follow up once bookings are
              completing again. Leave this off until real booking traffic has run for a
              while, so the threshold is set against numbers someone has seen.
            </p>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="availability_drift_armed"
                value="on"
                defaultChecked={availabilityDriftArmed}
                className="h-4 w-4"
              />
              Send a Slack alert when we offer times that are not really free
            </label>
            <p className="mt-1 text-xs text-fg-muted">
              Off: Slate still samples the times each bucket is offering and checks them
              against the real calendars every 5 minutes, recording what it finds in the
              logs, but nobody is notified. On: Slack gets an alert naming the bucket when
              too many of the times it offers turn out to be already busy, and a follow up
              once they are free again.
            </p>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="roster_coverage_armed"
                value="on"
                defaultChecked={rosterCoverageArmed}
                className="h-4 w-4"
              />
              Send a Slack alert when nobody works hours we say we are open
            </label>
            <p className="mt-1 text-xs text-fg-muted">
              Off: Slate still compares the business hours against everyone&apos;s working
              hours every 5 minutes and records what it finds in the logs, but nobody is
              notified. On: Slack gets an alert naming the days and times no bookable
              agent is scheduled for, and a follow up once every advertised hour is
              covered again. Leave this off until agents are live and have set their real
              working hours, or it will report the whole week as uncovered.
            </p>
          </section>

          <section className={cardCls}>
            <h2 className="mb-1 text-sm font-semibold">Slack destinations</h2>
            <p className="mb-4 text-xs text-fg-muted">
              Where alerts post. These apply to all alerts app-wide. Blank uses the
              server-configured channel. The info channel falls back to the alerts
              channel.
            </p>
            <div className="space-y-4">
              <div>
                <label className={labelCls} htmlFor="alerts_channel">
                  Alerts channel (urgent)
                </label>
                <input
                  id="alerts_channel"
                  name="alerts_channel"
                  type="text"
                  defaultValue={config?.alerts_channel ?? ""}
                  placeholder={envAlerts ? `default ${envAlerts}` : "#channel or channel ID"}
                  className={`${inputCls} w-72`}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="info_channel">
                  Info channel (quiet)
                </label>
                <input
                  id="info_channel"
                  name="info_channel"
                  type="text"
                  defaultValue={config?.info_channel ?? ""}
                  placeholder={envInfo ? `default ${envInfo}` : "falls back to alerts channel"}
                  className={`${inputCls} w-72`}
                />
              </div>
            </div>
          </section>

          <div className="flex items-center gap-4">
            <SubmitButton className={btnCls} pendingLabel="Saving…">
              Save alert settings
            </SubmitButton>
            <a href="/admin" className="text-xs text-pennie-blue underline dark:text-pennie-sky">
              Back to admin
            </a>
          </div>
        </form>

        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Direct-booking default bucket</h2>
          <p className="mb-4 text-xs text-fg-muted">
            When a direct-booking API caller does not pass a bucket code (XBC), Slate
            routes to this bucket. Leave it as &ldquo;No default&rdquo; to make a missing
            code an explicit error instead of a silent guess.
          </p>
          <form action={setDefaultBucket} className="space-y-4">
            <div>
              <label className={labelCls} htmlFor="default_bucket_code">
                Default bucket
              </label>
              <select
                id="default_bucket_code"
                name="default_bucket_code"
                defaultValue={defaultBucketCode ?? ""}
                className={`${inputCls} w-72`}
              >
                <option value="">No default (require a bucket code)</option>
                {bucketOptions.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.code} ({b.name})
                  </option>
                ))}
              </select>
              {bucketOptions.length === 0 && (
                <p className="mt-1 text-xs text-fg-muted">
                  No bookable buckets found to choose from.
                </p>
              )}
            </div>
            <SubmitButton className={btnCls} pendingLabel="Saving…">
              Save default bucket
            </SubmitButton>
          </form>
        </section>

        {/* When Pennie is OPEN, and (below) the hours a NEW agent starts on.
            Adjacent and named apart on purpose: they both look like "hours in a
            settings screen", and confusing them silently moves the whole roster's
            bookability (#1297). */}
        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Business hours</h2>
          <p className="mb-4 max-w-prose text-xs text-fg-muted">
            When Pennie is open. No lead is offered a time outside these hours, on any
            bucket, whatever an agent&apos;s own schedule says. A change applies to
            everyone straight away.
          </p>
          <BusinessHoursForm
            action={setBusinessHours}
            days={businessDays}
            zoneLabel={humanizeZone(BUSINESS_ZONE)}
            coverage={coverage}
          />
        </section>

        {org && (
          <section className={cardCls}>
            <h2 className="mb-1 text-sm font-semibold">Starting hours for a new agent</h2>
            <p className="mb-4 max-w-prose text-xs text-fg-muted">
              Only the hours a newly added agent begins with, and what the{" "}
              <strong>Use default hours</strong>{" "}button applies on an agent&apos;s page.
              Changing this moves nobody who is already set up, and it never widens the
              business hours above.
            </p>
            <form action={setOrgDefaultHours} className="flex flex-wrap items-end gap-3">
              <div>
                <label className={labelCls} htmlFor="default_timezone">
                  Timezone
                </label>
                <input
                  id="default_timezone"
                  name="default_timezone"
                  defaultValue={org.default_timezone}
                  className={`${inputCls} w-44`}
                />
              </div>
              <div>
                <span className={labelCls}>Days</span>
                <div className="mt-1">
                  <DayToggles
                    namePrefix="dday_"
                    isOn={(d) => org.default_weekdays.includes(d)}
                  />
                </div>
              </div>
              <div>
                <span className={labelCls}>Start</span>
                <TimeField
                  name="default_start"
                  ariaLabel="New agent start time"
                  defaultValue={minutesToTime(org.default_start_minute)}
                  className="mt-1"
                />
              </div>
              <div>
                <span className={labelCls}>End</span>
                <TimeField
                  name="default_end"
                  ariaLabel="New agent end time"
                  round="up"
                  defaultValue={minutesToTime(org.default_end_minute)}
                  className="mt-1"
                />
              </div>
              <SubmitButton className={btnCls} pendingLabel="Saving…">
                Save starting hours
              </SubmitButton>
            </form>
          </section>
        )}

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

        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">What the lead reads before booking</h2>
          <p className="mb-4 max-w-prose text-xs text-fg-muted">
            The description on the booking panel. Leave a blank line between
            paragraphs; they are shown apart, so a description and an ask do not run
            together. Up to {EVENT_DESCRIPTION_MAX} characters. A change reaches
            leads within a minute or two.
          </p>
          {eventTypes.length === 0 ? (
            <p className="text-xs text-fg-muted">
              No event type yet. Add one on the admin page first.
            </p>
          ) : (
            eventTypes.map((e) => (
              <form
                key={e.id}
                action={setEventDescription}
                className="mb-4 space-y-3 last:mb-0"
              >
                <input type="hidden" name="event_type_id" value={e.id} />
                <label className={labelCls} htmlFor={`description-${e.id}`}>
                  {e.name}
                </label>
                <textarea
                  id={`description-${e.id}`}
                  name="description"
                  rows={6}
                  maxLength={EVENT_DESCRIPTION_MAX}
                  defaultValue={e.description ?? ""}
                  className={`${inputCls} max-w-prose`}
                />
                <SubmitButton className={btnCls} pendingLabel="Saving…">
                  Save description
                </SubmitButton>
              </form>
            ))
          )}
        </section>

        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Booking reasons</h2>
          <p className="mb-3 text-xs text-fg-muted">
            The reasons staff and customers pick when rescheduling, cancelling, or
            reassigning a booking. Add, rename, reorder, or retire them without a deploy.
          </p>
          <a
            href="/admin/settings/reasons"
            className="text-sm font-semibold text-pennie-blue underline dark:text-pennie-sky"
          >
            Edit reason options
          </a>
        </section>

        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Diagnostics</h2>
          <p className="mb-3 text-xs text-fg-muted">
            When a booking&apos;s side effects (calendar, webhook) or a
            crash-recovered create keep failing to deliver, the row backs off and
            alerts. This view lists what is currently wedged and why.
          </p>
          <div className="flex flex-col gap-2">
            <a
              href="/admin/drain"
              className="text-sm font-semibold text-pennie-blue underline dark:text-pennie-sky"
            >
              View stuck deliveries
            </a>
            <a
              href="/admin/booking-outcomes"
              className="text-sm font-semibold text-pennie-blue underline dark:text-pennie-sky"
            >
              View booking API outcomes
            </a>
          </div>
        </section>
      </main>
    </>
  );
}

import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setMonitorSettings, setDefaultBucket, setBookingHorizon } from "@/app/admin/actions";
import { HORIZON_DEFAULT, HORIZON_MIN, HORIZON_MAX } from "@/lib/booking/settings";
import {
  ALERT_FIELDS as COOLDOWN_FIELDS,
  MONITOR_DEFAULTS,
  resolveLowVolumeArmed,
  envLowVolumeArmed,
} from "@/lib/monitor/settings";
import { AppHeader } from "@/components/AppHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { SettingsSaveNotice } from "./SettingsSaveNotice";
import { labelCls, inputCls, cardCls, btnCls } from "@/components/ui/styles";
import type { MonitorAlertConfig, MonitorSettings, User } from "@/lib/db/types";

export const dynamic = "force-dynamic";

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

  const storedByKey = new Map(rows.map((r) => [r.key, r.cooldown_min]));

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
  try {
    const db = supabaseAdmin();
    const [settings, buckets] = await Promise.all([
      db.from("booking_settings").select("default_bucket_code, horizon_days").eq("id", 1).maybeSingle(),
      db.from("buckets").select("code, name").eq("is_test", false).order("code"),
    ]);
    if (!settings.error && settings.data) {
      const row = settings.data as { default_bucket_code: string | null; horizon_days: number | null };
      defaultBucketCode = row.default_bucket_code;
      horizonDays = row.horizon_days;
    }
    if (!buckets.error && buckets.data) {
      bucketOptions = buckets.data as { code: string; name: string }[];
    }
  } catch {
    // Fall through to no default / empty options.
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
          <h1 className="text-2xl font-semibold text-white dark:text-fg">Alert settings</h1>
          <p className="mt-2 max-w-prose text-sm text-white/80 dark:text-fg-muted">
            Tune how often the monitor alerts fire and where they post, without a
            deploy. Leave a field blank to use its built-in default. Cooldowns are
            in minutes; floors are booking counts.
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
                    <p className="mt-1 text-xs text-fg-muted">{f.help}</p>
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
              Arm the low-volume alert (page Slack when bookings fall below a floor)
            </label>
            <p className="mt-1 text-xs text-fg-muted">
              Leave off during the ramp; turn on once Slate owns roughly full booking
              traffic. Saving applies immediately, no deploy needed.
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

        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Booking horizon</h2>
          <p className="mb-4 text-xs text-fg-muted">
            How many days ahead a lead can book. Applies to every bucket. Leave blank
            to use the default ({HORIZON_DEFAULT} days). A change refreshes availability
            across all buckets within a minute or two.
          </p>
          <form action={setBookingHorizon} className="space-y-4">
            <div>
              <label className={labelCls} htmlFor="horizon_days">
                Days ahead ({HORIZON_MIN} to {HORIZON_MAX})
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

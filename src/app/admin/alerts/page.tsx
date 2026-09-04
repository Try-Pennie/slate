import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setMonitorSettings } from "@/app/admin/actions";
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
import { SubmitButton } from "@/components/ui/SubmitButton";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { lastChangedLine, shortStamp } from "@/lib/admin/last-changed";
import { btnCls, cardCls, inputCls, labelCls, proseCls } from "@/components/ui/styles";
import type { MonitorAlertConfig, MonitorSettings, User } from "@/lib/db/types";

export const dynamic = "force-dynamic";

export default async function AlertSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");

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
    // error-ok: this read only turns an editor's id into their DISPLAY NAME for the
    // "last changed by" line, and `lastChangedLine` already renders an unresolved
    // id as "someone". Nothing acts on the empty map, no setting is decided by it,
    // and the settings themselves (which are the thing worth failing loud over)
    // come from the resolver above. The alternative, failing the whole settings
    // page over a name lookup, would hide every alarm threshold on it.
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
  const armed = process.env.BOOKING_VOLUME_ALERT_ARMED === "1";
  const envAlerts = process.env.SLACK_ALERTS_CHANNEL ?? "";
  const envInfo = process.env.SLACK_INFO_CHANNEL ?? "";

  return (
    <>
      <AdminPageHeader title="Alerts and floors">
        How often the monitor alerts fire, the volumes they judge against, and
        which Slack channel each one posts to. No deploy needed.
        <p className="mt-3 text-xs text-pennie-beige/70">{lastChanged}</p>
      </AdminPageHeader>
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
          {/* heading-gloss-ok: the UNIT of the numbers in the fields below. */}
          <h2 className="mb-1 text-sm font-semibold">Alert cooldowns (minutes)</h2>
          <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>
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
          {/* heading-gloss-ok: the UNIT again. A floor could be a rate or a count
              and the two read identically without this. */}
          <h2 className="mb-1 text-sm font-semibold">Low-volume floors (booking counts)</h2>
          <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>
            Expected minimum bookings in each window; below the floor triggers the
            low-volume alert (when armed).
          </p>
          <div className="flex flex-wrap gap-6">
            <div>
              {/* heading-gloss-ok: the WINDOW this floor is counted over. Two fields differ
                  by nothing else, so the bracket is the only thing telling them apart. */}
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
              {/* heading-gloss-ok: the other window, as above. */}
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
          <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>
            Where alerts post. These apply to all alerts app-wide. Blank uses the
            server-configured channel. The info channel falls back to the alerts
            channel.
          </p>
          <div className="space-y-4">
            <div>
              {/* heading-gloss-ok: which of two sibling channels this is. A reader choosing
                  between them needs the character of each, not a definition of
                  the word channel. */}
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
              {/* heading-gloss-ok: the quiet one, as above. */}
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
        </div>
      </form>
    </>
  );
}

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { SaveForm } from "@/components/ui/SaveForm";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setMonitorSettings, addRegalCallIgnore, removeRegalCallIgnore } from "@/app/admin/actions";
import { selectAllPages } from "@/lib/supabase/paginate";
import { log } from "@/lib/log";
import {
  ignoreListRows,
  ignorePickerOptions,
  type IgnoreRosterUser,
  type IgnoreRow,
} from "@/lib/admin/regal-call-ignores";
import { RegalCallIgnoreList, type RegalIgnoreRowView } from "@/components/admin/RegalCallIgnoreList";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import {
  ALERT_FIELDS as COOLDOWN_FIELDS,
  ALERT_URGENCY_ORDER,
  ALERT_URGENCY_COPY,
  MONITOR_DEFAULTS,
  quietedAlarms,
  formatMinutes,
  resolveLowVolumeArmed,
  resolveFailureRateArmed,
  resolveAvailabilityDriftArmed,
  resolveRosterCoverageArmed,
  resolveAwaitingActivationArmed,
  resolveBelowLeadTierArmed,
  resolveRegalCallsArmed,
  envLowVolumeArmed,
} from "@/lib/monitor/settings";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { SlackDestinations, SLACK_CHANNEL_LIST_ID } from "@/components/admin/SlackDestinations";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
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
  const saved = savedSentence(savedOutcome(sp.ok));
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");

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
  const awaitingActivationArmed = resolveAwaitingActivationArmed(config);
  const belowLeadTierArmed = resolveBelowLeadTierArmed(config);
  const regalCallsArmed = resolveRegalCallsArmed(config);

  // #2090: the Regal call ignore list and the roster its picker offers. Both reads
  // are paged, and a failure of either renders its own notice rather than an empty
  // list: "nobody is ignored" is a claim about who gets reported, and a read that
  // never ran must not make it (L10).
  let regalIgnores: { rows: RegalIgnoreRowView[]; options: { value: string; label: string }[] } | null = null;
  try {
    const db = supabaseAdmin();
    const [ignores, roster] = await Promise.all([
      selectAllPages<IgnoreRow>("alerts page regal ignore list", (from, to) =>
        db
          .from("regal_call_ignores")
          .select("user_id, reason, added_by, added_at")
          .order("user_id", { ascending: true })
          .range(from, to),
      ),
      selectAllPages<IgnoreRosterUser>("alerts page roster", (from, to) =>
        db
          .from("users")
          .select("id, name, email, role, is_test, deactivated_at")
          .order("id", { ascending: true })
          .range(from, to),
      ),
    ]);
    regalIgnores = { rows: ignoreListRows(ignores, roster), options: ignorePickerOptions(roster, ignores) };
  } catch (err) {
    log.error("admin-alerts", { msg: "regal ignore list unreadable" }, err instanceof Error ? err : undefined);
  }

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
      {/* #1990: the sentence comes from the OUTCOME, so it names the form
          that saved rather than whatever this page had written down. An
          unrecognised value (a bookmarked `?ok=1` from before outcomes were
          named) shows nothing, rather than confirming a save nobody made. */}
      {saved && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
      {sp.error && !saved && <SettingsSaveNotice ok={false} error={sp.error} saved="" />}
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
      <SaveForm action={setMonitorSettings} name="alerts" unsaved="changes to these alert settings" className="space-y-8">
        <section className={cardCls}>
          {/* heading-gloss-ok: the UNIT of the numbers in the fields below. */}
          <h2 className="mb-1 text-sm font-semibold">Alert cooldowns (minutes)</h2>
          <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>
            The minimum time between repeats of the same alert. Blank uses the
            default beside it.
          </p>
          {/* #1955: Dan, "I hate everything about this. we can do so much better
              than this design."

              Six faults, and the layout was most of them. Twenty three settings
              were a label, a FULL WIDTH input and a sentence each: about 910
              pixels of field to hold three to five digits, and the eye had to
              cross the whole page to get from one label to the next. Every row
              stated the unit three times (the heading, the placeholder, the
              hint) and the third was in different units from the first two. Nine
              of ten fields were empty, so their grey placeholders read enough
              like values to be mistaken for them.

              So: rows, not a stack. Narrow right aligned tabular inputs, so the
              digits line up down the page and a 10080 beside a 360 is visibly
              odd. The unit once, in the heading. The default beside the field
              rather than restated in a sentence.

              GROUPED BY VOLUME, which was the sixth fault: the section gave no
              sense of which of these matter while every sentence said so in a
              word somebody had to parse row by row. That word is data now
              (`urgency`), so the heading carries it and the sentences stopped
              repeating it.

              What each alert DOES stays reachable rather than visible, and that
              is deliberate. It is the only place any of these is explained, and
              23 sentences on one form is the wall of text Dan had stripped from
              the staffing depth page for exactly this reason (#1898, L579). So
              it is a `title` plus an `sr-only` span, the pattern RosterTable
              already uses (#1812), which reaches a mouse and a screen reader. */}
          {/* The rule on each heading is what separates the groups now, so the
              gap between them is smaller than it was: two boundary signals stacked
              would say the same thing twice. */}
          <div className="space-y-4">
            {ALERT_URGENCY_ORDER.map((level) => {
              const fields = COOLDOWN_FIELDS.filter((f) => f.urgency === level);
              if (fields.length === 0) return null;
              const copy = ALERT_URGENCY_COPY[level];
              return (
                // The rule lives on the GROUP, not the heading. `first:` matches
                // the first child of its own parent, and the heading is the first
                // child of every group, so putting it there drew no rule anywhere
                // (seen on the page, not in a test). Here `first:` means the first
                // group, which is what it was meant to say.
                <div key={level} className="border-t border-border pt-4 first:border-t-0 first:pt-0">
                  {/* #2069: Dan, clicking through this section, "these feel like
                      they're supposed to be headers but it's not clear".

                      The semantics were already right: it is a real h3 and a screen
                      reader gets a heading. What was missing was every visual
                      signal at once. It was `text-xs` over `text-xs` rows, so
                      weight was the only difference, and a semibold 12px line above
                      regular 12px rows reads as an emphasised sentence rather than
                      a level (L634). The rows carried rules and the one element
                      marking a boundary carried none. And the one word label shared
                      a baseline with its explanation, which is the shape of prose.

                      So it takes a size step up from the rows, a rule of its own,
                      and its own line, with the explanation beneath it. The
                      explanation stays: it is the only place the four levels are
                      defined, and it is one per group rather than one per row. */}
                  <h3 className="text-sm font-semibold text-fg">
                    {copy.label}
                  </h3>
                  <p className="mt-0.5 text-xs text-fg-muted">{copy.meaning}</p>
                  <ul className="mt-2">
                    {fields.map((f) => {
                      const stored = storedByKey.get(f.key);
                      const defMin = MONITOR_DEFAULTS.cooldownMs[f.key] / 60_000;
                      return (
                        <li
                          key={f.key}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-1.5 first:border-t-0"
                        >
                          <label
                            className="min-w-0 flex-1 text-xs text-fg"
                            htmlFor={`cooldown_${f.key}`}
                            title={f.help}
                          >
                            {f.label}
                            <span className="sr-only">{`. ${f.help}`}</span>
                          </label>
                          {/* NO sentence for an override, deliberately. The
                              value and its default now sit side by side on one
                              line, so a 10080 beside "default 30" is visible
                              without reading anything, and the notice above this
                              section already names every override with its
                              value, its default and the date it changed. A
                              third statement of the same fact on the row is
                              decoration (L558), and "not more prose" is Dan's
                              own constraint from the staffing depth page. */}
                          {/* The width lives on a WRAPPER, not on the input.
                              `inputCls` sets `w-full`, and a `w-20` appended
                              after it loses or wins by whatever order Tailwind
                              happens to emit the two utilities in, which is
                              invisible at the call site (L509). Measured: the
                              first version of this row still rendered a 912px
                              field, so the shared style is given a box to fill
                              rather than argued with. Changing `inputCls`
                              itself belongs to #1855. */}
                          <span className="block w-24 shrink-0">
                            <input
                              id={`cooldown_${f.key}`}
                              name={`cooldown_${f.key}`}
                              type="number"
                              min={1}
                              inputMode="numeric"
                              defaultValue={stored ?? ""}
                              aria-describedby={`cooldown_${f.key}_default`}
                              /* Only the WIDTH changes, which is what the issue
                                 is about. The height stays `inputCls`'s 44px,
                                 which the design system asks for as a target
                                 size, and measured at 44px on the page.

                                 An `h-9` written here first was INERT for the
                                 same reason a `w-20` was: `inputCls` sets both
                                 dimensions and an appended utility wins or
                                 loses by Tailwind's emit order (L509). It read
                                 as a deliberate 36px row and rendered 44px. */
                              className={`${inputCls} mt-0 text-right tabular-nums`}
                            />
                          </span>
                          <span
                            id={`cooldown_${f.key}_default`}
                            className="w-28 text-xs text-fg-muted tabular-nums"
                          >
                            default {defMin}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
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
            attempts fail over its rolling window, and a follow up once bookings are
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
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="awaiting_activation_armed"
              value="on"
              defaultChecked={awaitingActivationArmed}
              className="h-4 w-4"
            />
            Send a Slack alert when somebody is stuck outside the booking pool
          </label>
          <p className="mt-1 text-xs text-fg-muted">
            Off: Slate still checks every 5 minutes who the roster counts as working
            but cannot be booked, and records what it finds in the logs, but nobody is
            notified. On: Slack gets an alert naming anyone who has been waiting more
            than four hours, and a follow up once nobody is. Leave this off until
            somebody has watched a few ordinary days, so the alert is turned on
            against numbers a person has seen.
          </p>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="below_lead_tier_armed"
              value="on"
              defaultChecked={belowLeadTierArmed}
              className="h-4 w-4"
            />
            Send a Slack alert when a lead is booked with a team below their tier
          </label>
          <p className="mt-1 text-xs text-fg-muted">
            Off: Slate still holds every upcoming call against the tier Salesforce
            gives the lead today, every 5 minutes, and records what it finds in the
            logs, but nobody is notified. On: Slack gets an alert for each call that
            is with a lower team than the lead&apos;s tier, and a follow up once it
            is moved, the score comes down, or the call is cancelled. Turn this on
            before cutover: it replaces the cal.com Slack workflow that stops working
            then.
          </p>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="regal_calls_armed"
              value="on"
              defaultChecked={regalCallsArmed}
              className="h-4 w-4"
            />
            Send a Slack alert when somebody not taking bookings is placing calls
          </label>
          <p className="mt-1 text-xs text-fg-muted">
            Off: Slate still reads every call Regal reports, checks every 5 minutes who
            placed one while their bookable switch is off or they are deactivated, and
            records it in the logs, but nobody is notified. On: Slack gets one alert per
            person a day, plus an alert when no call from a Slate user arrived all
            business day or Regal sends calls Slate cannot read. Leave this off until
            Regal is sending calls and somebody has watched a few ordinary days.
          </p>
        </section>

        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Slack destinations</h2>
          <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>
            Where alerts post, app-wide. Pick a channel from the list or paste an
            id. Leave a field blank to use whatever the deployment itself is
            configured with.
          </p>
          {/* #1957: what the rules RESOLVE to, rather than the rules. The Slack
              check inside it is one network call, so it renders behind a
              boundary and the form draws immediately without it. */}
          <Suspense
            fallback={
              <p className="mb-4 text-xs text-fg-muted">Reading the current destinations...</p>
            }
          >
            <SlackDestinations config={config} envAlerts={envAlerts} envInfo={envInfo} />
          </Suspense>
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
                list={SLACK_CHANNEL_LIST_ID}
                defaultValue={config?.alerts_channel ?? ""}
                // #1957: no bare id here either. The panel above already names
                // the deployment's default channel, and the id repeated in grey
                // was the last place on this page that made a person look one up.
                placeholder={envAlerts ? "blank uses the default above" : "pick a channel or paste an id"}
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
                list={SLACK_CHANNEL_LIST_ID}
                defaultValue={config?.info_channel ?? ""}
                placeholder={envInfo ? `default ${envInfo}` : "falls back to alerts channel"}
                className={`${inputCls} w-72`}
              />
            </div>
            <div>
              {/* heading-gloss-ok: who reads it, as with the two above. This one is for
                  the sales side rather than for whoever keeps Slate running. */}
              <label className={labelCls} htmlFor="handoff_channel">
                Handoff channel (sales)
              </label>
              <input
                id="handoff_channel"
                name="handoff_channel"
                type="text"
                list={SLACK_CHANNEL_LIST_ID}
                defaultValue={config?.handoff_channel ?? ""}
                // #2367: no fallback to either channel above, deliberately. A booking
                // handoff posted where sales does not read reaches nobody who can act.
                placeholder="pick the channel sales reads"
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
      </SaveForm>

      {/* #2090. Outside the settings form on purpose: each add and each removal is
          its own action with its own confirmation, and a nested form is not valid
          markup. */}
      <section id="regal-ignores" className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">People whose Regal calls are not reported</h2>
        <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>
          Managers, admins, team leads and test users are never reported for calling while
          Slate routes no bookings to them, so only agents can be added here.
        </p>
        {regalIgnores ? (
          <RegalCallIgnoreList
            rows={regalIgnores.rows}
            options={regalIgnores.options}
            addAction={addRegalCallIgnore}
            removeAction={removeRegalCallIgnore}
          />
        ) : (
          <UnreadableNotice>
            The ignore list could not be read, so this page cannot say who is on it. Nothing has
            changed; reload to try again.
          </UnreadableNotice>
        )}
      </section>
    </>
  );
}

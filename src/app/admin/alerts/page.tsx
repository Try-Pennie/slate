import { Fragment, Suspense } from "react";
import { redirect } from "next/navigation";
import { SaveForm } from "@/components/ui/SaveForm";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setMonitorSettings, setVolumeRampEnd, addRegalCallIgnore, removeRegalCallIgnore } from "@/app/admin/actions";
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
  TIER_RECOVERY_BOUNDS,
  POOL_NEARLY_FULL_BOUNDS,
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
  envFloors,
  resolveFloors,
  type MonitorAlertKey,
} from "@/lib/monitor/settings";
import { VolumeFloors } from "@/components/admin/VolumeFloors";
import { CalcomRetirementSwitch } from "@/components/admin/CalcomRetirementSwitch";
import { CALCOM_RETIREMENT_FORM } from "@/lib/calcom/retirement";
import { loadPutBackCounts, putBackSavedSentence, type PutBackCounts } from "@/lib/calcom/put-back";
import { VolumeLearning, type PageCoverageView } from "@/components/admin/VolumeLearning";
import { EARLIEST_RAMP_END, RAMP_END_FORM, baselineInForce, type BaselineInForce } from "@/lib/monitor/volume-relearn";
import { LEARNING } from "@/lib/monitor/volume-learning";
import { learningStatusCopy, tierLearningLines } from "@/lib/monitor/volume-relearn-copy";
import { LOW_TIER } from "@/lib/monitor/volume-tiers";
import {
  LOW_PAGES_ON_SLATE,
  lowPilot,
  pageCoverage,
  pilotPageLine,
  pagesNotOnSlateLines,
  pageSourceStatus,
  type PageSourceMeasure,
} from "@/lib/monitor/page-volume";
import { measurePageSources } from "@/lib/monitor/customer-bookings";
import { MEASURED_PAGE_BASELINES } from "@/lib/monitor/page-volume-baseline";
import { pilotSettingsCache } from "@/lib/salesforce/pilot-settings";
import { floorTable } from "@/lib/admin/volume-floor-table";
import { loadBusinessHours } from "@/lib/booking/business-hours-load";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { SlackDestinations } from "@/components/admin/SlackDestinations";
import { checkChannels } from "@/lib/notify/slack-channel-names";
import { SlackChannelField } from "@/components/admin/SlackChannelField";
import { listSlackChannels } from "@/lib/notify/slack";
import { channelNames } from "@/lib/notify/slack-channel-check";
import { effectiveChannels } from "@/lib/notify/channel-effective";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { lastChangedLine, shortStamp } from "@/lib/admin/last-changed";
import { btnCls, cardCls, inputCls, labelCls, proseCls } from "@/components/ui/styles";
import type { MonitorAlertConfig, MonitorSettings, User } from "@/lib/db/types";

export const metadata = { title: "Alerts and floors" };

export const dynamic = "force-dynamic";

// Module scope so the clock read does not trip react-hooks/purity in render: the
// learning status says how long ago the last refit ran, which needs the present.
function learningStatusNow(state: BaselineInForce) {
  return learningStatusCopy(state, Date.now());
}

/** The other tiers' lines (#2874), for the same reason: they say how old a refit is. */
function tierLinesNow(input: { rampEndOn: string | null; learning: unknown }) {
  return tierLearningLines(input, Date.now());
}

/**
 * #2765: what the per page section says in place of the pages' floors, or null once
 * every real booking in the alarm's lookback carried its source. Through the same
 * measurement the readiness gate reads; a failed read is its own sentence, never a
 * lookback with nothing unsourced, which is the answer that would show the floors.
 *
 * #2960: and, beside the floors, how many hand made bookings with no host page were
 * set aside, or null when none were. An unrecorded status already carries it.
 */
async function pageSourceNoticeNow(): Promise<{ notice: string | null; setAside: string | null }> {
  let measured: PageSourceMeasure | null = null;
  try {
    measured = await measurePageSources(supabaseAdmin(), Date.now());
  } catch (err) {
    log.error("admin-alerts", { msg: "page sources unreadable" }, err instanceof Error ? err : undefined);
  }
  const status = pageSourceStatus(measured);
  return status.state === "recorded" ? { notice: null, setAside: status.note } : { notice: status.text, setAside: null };
}

/** #2890: what putting cal.com back would bring into line, read outside render. */
async function loadPutBack(): Promise<PutBackCounts> {
  return loadPutBackCounts(supabaseAdmin(), Date.now());
}

/** The two outcomes the learning section confirms in place rather than at the top. */
const LEARNING_OUTCOMES = new Set(["volume-ramp-end-set", "volume-ramp-end-cleared"]);
/** #2875: the two outcomes the cal.com switch confirms beside itself. */
const CALCOM_OUTCOMES = new Set(["calcom-retired", "calcom-live"]);


/** The settings that tune one alert beyond its cooldown, drawn directly under that
 *  cooldown in the same row shape because they are part of the same alert: when a
 *  debt tier page ends (#3227), and the nearly full pool line (#3559). The column
 *  names are the form field names, so the save action and this list cannot drift
 *  onto different spellings. */
const ALERT_TUNING_FIELDS: Partial<
  Record<
    MonitorAlertKey,
    readonly {
      name: "empty_tier_recovery_min_times" | "empty_tier_recovery_hold_min" | "pool_nearly_full_open_pct";
      label: string;
      help: string;
      bounds: { min: number; max: number };
      defaultValue: number;
    }[]
  >
> = {
  empty_tier: [
    {
      name: "empty_tier_recovery_min_times",
      label: "Open times before it ends",
      help: "How many booking times a paged debt tier must offer across the days the booker shows for its page to end. The page itself still starts only when the tier offers none.",
      bounds: TIER_RECOVERY_BOUNDS.minOpenTimes,
      defaultValue: MONITOR_DEFAULTS.tierRecovery.minOpenTimes,
    },
    {
      name: "empty_tier_recovery_hold_min",
      label: "Minutes held before it ends",
      help: "How long the tier must keep offering that many times before the all clear is sent. Dropping below that number starts the wait again. Zero sends the all clear on the first check that finds enough.",
      bounds: TIER_RECOVERY_BOUNDS.holdMin,
      defaultValue: MONITOR_DEFAULTS.tierRecovery.holdMin,
    },
  ],
  pool_nearly_full: [
    {
      name: "pool_nearly_full_open_pct",
      label: "Percent still open",
      help: "A debt tier is named when fewer than this percentage of its possible starts, across the days the booker shows, are still open.",
      bounds: POOL_NEARLY_FULL_BOUNDS.openPct,
      defaultValue: MONITOR_DEFAULTS.poolNearlyFullOpenPct,
    },
  ],
};

export default async function AlertSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; form?: string; copy?: string; remove?: string }>;
}) {
  const sp = await searchParams;
  const outcome = savedOutcome(sp.ok);
  const saved = savedSentence(outcome);
  // #2739: the ramp end form sits lower on the page, and its confirmation is drawn
  // beside it, where the person pressed, rather than above the fold (L608).
  const savedHere = outcome !== null && LEARNING_OUTCOMES.has(outcome);
  // #2875: likewise the cal.com switch, which sits at the foot of the page, and its
  // refusals by the form name they carry.
  const savedByCalcom = outcome !== null && CALCOM_OUTCOMES.has(outcome);
  const refusedByCalcom = !!sp.error && sp.form === CALCOM_RETIREMENT_FORM;
  // Its refusals too, which carry the form's name because a refusal has no outcome.
  const refusedHere = !!sp.error && sp.form === RAMP_END_FORM;
  // #2890: putting cal.com back is built per render, from the count the action
  // measured and carried on the redirect.
  const calcomSaved = outcome === "calcom-live" ? putBackSavedSentence(sp.copy, sp.remove) : saved;
  const calcomNotice =
    savedByCalcom && calcomSaved ? (
      <SettingsSaveNotice ok saved={calcomSaved} error={sp.error} />
    ) : refusedByCalcom ? (
      <SettingsSaveNotice ok={false} error={sp.error} saved="" />
    ) : undefined;
  const learningNotice =
    savedHere && saved ? (
      <SettingsSaveNotice ok saved={saved} error={sp.error} />
    ) : refusedHere ? (
      <SettingsSaveNotice ok={false} error={sp.error} saved="" />
    ) : undefined;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;

  // Read stored values to prefill. Guarded: the tables may not exist yet during
  // a migrate-before-deploy window, and a missing table must not 500 the page.
  let rows: MonitorSettings[] = [];
  let config: MonitorAlertConfig | null = null;
  // #2739: whether the config row was READ, so the learning section can say it
  // could not tell rather than reporting "no ramp end declared" off a failed read.
  let configReadable = false;
  try {
    const db = supabaseAdmin();
    const [cooldowns, cfg] = await Promise.all([
      db.from("monitor_settings").select("*"),
      db.from("monitor_alert_config").select("*").eq("id", 1).maybeSingle(),
    ]);
    if (!cooldowns.error && cooldowns.data) rows = cooldowns.data as MonitorSettings[];
    if (!cfg.error && cfg.data) config = cfg.data as MonitorAlertConfig;
    configReadable = !cfg.error;
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
  // #2875: null when the row could not be read, or was read without the column
  // (a deploy ahead of migration 0147), never a guess. No row at all is the
  // column's default, live.
  const calcomRetired: boolean | null = !configReadable
    ? null
    : config === null
      ? false
      : typeof config.calcom_retired === "boolean"
        ? config.calcom_retired
        : null;
  // #2890: what putting cal.com back would bring into line, for the confirmation.
  // Read only while retired, since only then is there a put back to confirm.
  const putBack: PutBackCounts =
    calcomRetired === true ? await loadPutBack() : { copy: null, remove: null };
  // #1956: the measured floors and anything replacing them, through the same
  // resolver the monitor uses, so the page shows what the alarm will judge against.
  const floorPolicy = resolveFloors(config, envFloors());
  // #2739: which baseline that is, through the judge `resolveFloors` itself used, so
  // the words and the floors cannot disagree.
  const learningInput = { rampEndOn: config?.volume_ramp_end_on ?? null, learning: config?.volume_learning ?? null };
  const learning = learningStatusNow(baselineInForce(learningInput, LOW_TIER));
  // #2874: every other tier's line, judged by the same judge the monitor reads.
  const tierLines = tierLinesNow(learningInput);
  // The org's week decides which hours the floor table shows. Unreadable is its
  // own state (every hour shown, and said), never an empty table (L10).
  let week: { rules: { weekday: number; start_minute: number; end_minute: number }[] } | null = null;
  try {
    week = await loadBusinessHours();
  } catch (err) {
    log.error(
      "admin-alerts",
      { msg: "business week unreadable for the floor table" },
      err instanceof Error ? err : undefined,
    );
  }

  // #2090: the Regal call ignore list and the roster its picker offers. Both reads
  // are paged, and a failure of either renders its own notice rather than an empty
  // list: "nobody is ignored" is a claim about who gets reported, and a read that
  // never ran must not make it (L10).
  let regalIgnores: { rows: RegalIgnoreRowView[]; options: { value: string; label: string }[] } | null = null;
  try {
    const db = supabaseAdmin();
    const [ignores, roster] = await Promise.all([
      selectAllPages<IgnoreRow>("alerts page regal ignore list", "user_id", () =>
        db
          .from("regal_call_ignores")
          .select("user_id, reason, added_by, added_at"),
      ),
      selectAllPages<IgnoreRosterUser>("alerts page roster", "id", () =>
        db
          .from("users")
          .select("id, name, email, role, is_test, deactivated_at"),
      ),
    ]);
    regalIgnores = { rows: ignoreListRows(ignores, roster), options: ignorePickerOptions(roster, ignores) };
  } catch (err) {
    log.error("admin-alerts", { msg: "regal ignore list unreadable" }, err instanceof Error ? err : undefined);
  }

  // #2738's per page coverage, against the same week the floor tables use. Only the
  // pages Slate carries (#2878): the rest are named as not judged beside the table.
  // The pages are judged only while the pilot switch in Salesforce sends Slate every Low
  // lead, through the same `lowPilot` the alarm decides by, so the table appears exactly
  // when the alarm is judging.
  const pilot = lowPilot(
    await pilotSettingsCache.read().catch((err: unknown) => {
      log.error("admin-alerts", { msg: "pilot settings unreadable" }, err instanceof Error ? err : undefined);
      return null;
    }),
  );
  const pageFloors = pilot.state === "whole" ? MEASURED_PAGE_BASELINES : null;
  // While they are not judged there are no floors to count, and the section says why in
  // place of the table rather than reading as an unreadable week.
  const coverage: PageCoverageView[] | null =
    week && pageFloors
      ? LOW_PAGES_ON_SLATE.map((page) => {
          const c = pageCoverage(page, pageFloors[page.id], week);
          return { id: page.id, name: page.name, open: c.open, judged: c.judged };
        })
      : null;
  // #2765: said in place of that coverage until every booking carries its page.
  const { notice: sourceNotice, setAside: sourceSetAside } = await pageSourceNoticeNow();

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
  // #1956: the EFFECTIVE arming (store > env > disarmed). This used to read the env
  // var alone, so it announced "disarmed" to an admin who had armed the alarm here.
  const armed = lowVolumeArmed;
  const envAlerts = process.env.SLACK_ALERTS_CHANNEL ?? "";
  const envInfo = process.env.SLACK_INFO_CHANNEL ?? "";
  // #2438: started here and NOT awaited, so the form draws at once and the Slack
  // reads stream in. Both never reject. The checks cover every stored channel,
  // the handoff one included, and serve the panel (where alerts land) and the
  // fields (the name of a stored channel the list cannot hold, which is how a
  // private channel still reads as #name). The list is read once for all three
  // fields.
  const effective = effectiveChannels(config, { alertsEnv: envAlerts, infoEnv: envInfo });
  const channelChecks = checkChannels([
    effective.alerts.channel,
    effective.info.channel,
    config?.handoff_channel ?? "",
  ]);
  // Only the STORED channels' names, the same set the save looks a typed name up
  // in, so the field never takes a name the save would refuse (L99).
  const storedIds = [config?.alerts_channel, config?.info_channel, config?.handoff_channel].filter(
    (c): c is string => !!c,
  );
  const storedChannelNames = channelChecks.then((checks) => channelNames(checks, storedIds));
  const slackChannelList = listSlackChannels();

  return (
    <>
      <AdminPageHeader title="Alerts and floors">
        How often the monitor alerts fire, the volumes they judge against, and
        which Slack channel each one posts to. No deploy needed.
        {/* #3079: was beige at 70% from when this header sat on navy; on the
            light card it measured below 4.5:1 in the rendered scan. Same
            treatment as the booking reasons header. */}
        <p className="mt-3 text-xs">{lastChanged}</p>
      </AdminPageHeader>
      {/* #1990: the sentence comes from the OUTCOME, so it names the form
          that saved rather than whatever this page had written down. An
          unrecognised value (a bookmarked `?ok=1` from before outcomes were
          named) shows nothing, rather than confirming a save nobody made. */}
      {saved && !savedHere && !savedByCalcom && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
      {sp.error && !saved && !refusedHere && !refusedByCalcom && (
        <SettingsSaveNotice ok={false} error={sp.error} saved="" />
      )}
      {!armed && (
        <div className="rounded-md border border-border bg-[var(--bg-alt)] px-5 py-4 text-sm text-fg-muted">
          The low booking volume alarm is <strong>off</strong>: its floors below are measured
          and ready, and nothing pages until it is turned on.
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
                        <Fragment key={f.key}>
                        <li
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
                        {/* #3227, #3559: the settings that tune this alert sit
                            directly under its cooldown, in the same row shape,
                            because they are part of the same alert. */}
                        {(ALERT_TUNING_FIELDS[f.key] ?? []).map((r) => (
                            <li
                              key={r.name}
                              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-1.5"
                            >
                              <label className="min-w-0 flex-1 pl-4 text-xs text-fg" htmlFor={r.name} title={r.help}>
                                {r.label}
                                <span className="sr-only">{`. ${r.help}`}</span>
                              </label>
                              <span className="block w-24 shrink-0">
                                <input
                                  id={r.name}
                                  name={r.name}
                                  type="number"
                                  min={r.bounds.min}
                                  max={r.bounds.max}
                                  step={1}
                                  inputMode="numeric"
                                  defaultValue={config?.[r.name] ?? ""}
                                  aria-describedby={`${r.name}_default`}
                                  className={`${inputCls} mt-0 text-right tabular-nums`}
                                />
                              </span>
                              <span id={`${r.name}_default`} className="w-28 text-xs text-fg-muted tabular-nums">
                                default {r.defaultValue}
                              </span>
                            </li>
                          ))}
                        </Fragment>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>

        <section className={cardCls}>
          {/* #1956: the floors are MEASURED per weekday and hour; the two numbers
              that used to be the primary input are an override of that now. */}
          <VolumeFloors
            baseline={floorPolicy.baseline}
            inForce={learning.inForce}
            table={floorTable(floorPolicy.baseline, week)}
            weekReadable={week !== null}
            override30={floorPolicy.override30}
            override120={floorPolicy.override120}
            stored30={config?.floor_30 ?? null}
            stored120={config?.floor_120 ?? null}
          />
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
            alert when bookings fall below the floors above. The floors are fitted to the
            traffic named above, so turn this on once that traffic reaches Slate.
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
            is moved, the score comes down, or the call is cancelled.{" "}
            {calcomRetired === true
              ? "cal.com is retired, so this is the only check doing what its Slack workflow did."
              : "Turn this on before cutover: it replaces the cal.com Slack workflow that stops working then."}
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
            <SlackDestinations
              config={config}
              envAlerts={envAlerts}
              envInfo={envInfo}
              checks={channelChecks}
            />
          </Suspense>
          <div className="space-y-4">
            <div>
              {/* heading-gloss-ok: which of two sibling channels this is. A reader choosing
                  between them needs the character of each, not a definition of
                  the word channel. */}
              <label className={labelCls} htmlFor="alerts_channel">
                Alerts channel (urgent)
              </label>
              {/* #2438: Slate's own picker, not a native datalist. It shows the
                  channel by name and posts its id. */}
              <SlackChannelField
                id="alerts_channel"
                name="alerts_channel"
                defaultValue={config?.alerts_channel ?? ""}
                listing={slackChannelList}
                names={storedChannelNames}
                // #1957: no bare id here either. The panel above already names
                // the deployment's default channel, and the id repeated in grey
                // was the last place on this page that made a person look one up.
                placeholder={envAlerts ? "blank uses the default above" : "pick a channel or paste an id"}
                className="w-72"
              />
            </div>
            <div>
              {/* heading-gloss-ok: the quiet one, as above. */}
              <label className={labelCls} htmlFor="info_channel">
                Info channel (quiet)
              </label>
              <SlackChannelField
                id="info_channel"
                name="info_channel"
                defaultValue={config?.info_channel ?? ""}
                listing={slackChannelList}
                names={storedChannelNames}
                placeholder={envInfo ? `default ${envInfo}` : "falls back to alerts channel"}
                className="w-72"
              />
            </div>
            <div>
              {/* heading-gloss-ok: who reads it, as with the two above. This one is for
                  the sales side rather than for whoever keeps Slate running. */}
              <label className={labelCls} htmlFor="handoff_channel">
                Handoff channel (sales)
              </label>
              <SlackChannelField
                id="handoff_channel"
                name="handoff_channel"
                defaultValue={config?.handoff_channel ?? ""}
                listing={slackChannelList}
                names={storedChannelNames}
                // #2367: no fallback to either channel above, deliberately. A booking
                // handoff posted where sales does not read reaches nobody who can act.
                placeholder="pick the channel sales reads"
                className="w-72"
              />
            </div>
            {/* Migration 0188: the owner reassign notice (#2372) posts only to the
                handoff channel, so its switch sits under that field. Off unless an
                admin turns it on. */}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="owner_reassign_notice_on"
                value="on"
                defaultChecked={config?.owner_reassign_notice_on === true}
                className="h-4 w-4"
              />
              Post in the handoff channel when a lead&apos;s call goes to the advisor they have already spoken with
            </label>
          </div>
        </section>

        <div className="flex items-center gap-4">
          <SubmitButton className={btnCls} pendingLabel="Saving…">
            Save alert settings
          </SubmitButton>
        </div>
      </SaveForm>

      {/* #2739. Outside the settings form on purpose, like the ignore list below:
          the ramp end is its own confirmed action, and a nested form is not valid
          markup. Directly under the form, so it sits after the floors it changes. */}
      {configReadable ? (
        <VolumeLearning
          rampEndOn={config?.volume_ramp_end_on ?? null}
          detail={learning.detail}
          tiers={tierLines}
          coverage={coverage}
          sourceNotice={sourceNotice}
          sourceSetAside={sourceSetAside}
          pagePilot={pilotPageLine(pilot)}
          heldOff={pagesNotOnSlateLines()}
          notice={learningNotice}
          action={setVolumeRampEnd}
          earliest={EARLIEST_RAMP_END}
          minWeeks={LEARNING.minWeeks}
        />
      ) : (
        <section id="volume-learning" className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Learning the floors from Slate&apos;s bookings</h2>
          {/* The outcome of a press that just happened is still true when the read
              back fails, so it is drawn here too, and the unreadable sentence then
              does not claim nothing changed (L11). */}
          {learningNotice}
          <UnreadableNotice>
            {savedHere
              ? "The alert settings could not be read back, so this page cannot show the ramp end now stored or which floors are in force. Reload to see them."
              : "The alert settings could not be read, so this page cannot say whether a ramp end is set or which floors are in force. Nothing has changed; reload to try again."}
          </UnreadableNotice>
        </section>
      )}
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
      {/* #2875. Last on the page, because it is pressed once, at cutover, and it is
          the most far reaching control here (L609). Outside the settings form like
          the two sections above it: its own confirmed action. */}
      <section id="calcom-retirement" className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">cal.com</h2>
        <CalcomRetirementSwitch retired={calcomRetired} putBack={putBack} notice={calcomNotice} />
      </section>
    </>
  );
}

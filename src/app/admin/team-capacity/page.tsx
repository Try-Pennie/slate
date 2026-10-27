import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings, canManageAgents } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { log } from "@/lib/log";
import { cardCls } from "@/components/ui/styles";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import StandaloneTheme from "@/components/StandaloneTheme";
import { TeamCapacityView } from "@/components/TeamCapacityView";
import { setNearlyFullPct } from "@/app/admin/actions";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { BUSINESS_ZONE, windowOnDate } from "@/lib/booking/business-hours";
import { loadBusinessHours } from "@/lib/booking/business-hours-load";
import { readNearlyFullPct } from "@/lib/booking/settings";
import { BUSY_WINDOW_AHEAD_DAYS } from "@/lib/google/sync-coalesce";
import { loadTeamCapacity, type TeamCapacityReport } from "@/lib/admin/team-capacity-load";
import { loadCapacityHistoryDay, readSavedDays } from "@/lib/admin/capacity-history-store";
import { EVERY_SAVED_DAY_FROM } from "@/lib/admin/capacity-history";
import { HISTORY_UNREADABLE_COPY, LINE_UNREADABLE_COPY, UNMEASURABLE_COPY } from "@/lib/admin/team-capacity-copy";
import { pickableDays, teamCapacityView, todayHasEnded, type CapacityDaySource } from "@/lib/admin/team-capacity-view";
import { fixtureView, type DesignFixtureFile } from "@/lib/admin/team-capacity-fixture";
import { readDesignFixture } from "@/lib/admin/design-fixture-read";
import { judgePace, type PaceRead } from "@/lib/admin/team-capacity-pace";
import { readPaceRows } from "@/lib/admin/team-capacity-pace-load";
import { dayTotals, type TeamCapacityAdvisor } from "@/lib/admin/team-capacity";

export const metadata = { title: "Team capacity" };

export const dynamic = "force-dynamic";

/**
 * Team capacity (#3936): every advisor's room per day, for deciding whether to slow ad spend.
 * The settled design is docs/design/team-capacity.html and the numbers are #3935's calculation.
 *
 * Manager or above, org scoped: the caller's own `org_id` bounds every read, all of them server
 * side through the secret key client. Only an admin moves the nearly full line, and the server
 * action checks that again (`setNearlyFullPct`).
 *
 * `?day=` picks a date: a coming one is measured like the window's days, a past one is read from
 * history (#3940). `?frame=` renders one of the design's frames from its fixture, so the design
 * match score compares like with like; it answers only when the e2e run sets the flag and the
 * request is to this machine (`designFixturesEnabled`).
 */
export default async function TeamCapacityPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; frame?: string; ok?: string; error?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canManageAgents(me.role)) {
    return <main className="p-8 text-sm text-fg-muted">You need a manager or admin account to view team capacity.</main>;
  }
  const sp = await searchParams;
  const canEdit = canEditOrgSettings(me.role);
  const zoneLabel = DateTime.now().setZone(BUSINESS_ZONE).toFormat("ZZZZ");
  const saved = savedSentence(savedOutcome(sp.ok));
  const header = (
    <>
      <AdminPageHeader title="Team capacity">All times are {zoneLabel}.</AdminPageHeader>
      {/* What the nearly full line's Save did, on the page it was pressed on (L608). */}
      {saved && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
      {sp.error && !saved && <SettingsSaveNotice ok={false} error={sp.error} saved="" />}
    </>
  );
  const refused = (copy: { heading: string; body: string }) => (
    <>
      {header}
      <section className={cardCls} data-tc="failed">
        <h2 className="text-base font-semibold text-fg">{copy.heading}</h2>
        <p className="mt-1 text-fg-muted">{copy.body}</p>
      </section>
    </>
  );

  // The design's frames, from the fixture, never from the database.
  const fixture = await readDesignFixture<DesignFixtureFile>(sp.frame, "team-capacity");
  if (fixture && sp.frame) {
    const f = fixtureView(fixture, sp.frame);
    const theme = <StandaloneTheme theme={f.theme} />;
    if (!f.report.measurable) return <>{theme}{refused(UNMEASURABLE_COPY[f.report.reason])}</>;
    const r = f.report;
    const sources = r.days.map((iso, i): CapacityDaySource => ({
      iso,
      kind: r.windowDays.includes(iso) ? "window" : iso < r.windowDays[0] ? "past" : "beyond",
      advisors: r.advisors.map((a) => ({ advisor: a, day: a.days[i] })),
    }));
    return (
      <>
        {theme}
        {header}
        <TeamCapacityView
          view={teamCapacityView({ zone: r.zone, todayIso: r.windowDays[0], nowMs: r.nowMs, durationMin: r.eventType.duration_min, nearlyFullPct: f.nearlyFullPct, days: sources, pace: judgePace(f.pace, r.nowMs), todayEnded: f.todayEnded })}
          zone={r.zone}
          todayIso={r.windowDays[0]}
          initialIndex={f.dayIndex}
          nearlyFullPct={f.nearlyFullPct}
          canEdit
          pickable={f.pickable}
          initialCalendarOpen={f.calendarOpen}
          initialChangeOpen={f.changeOpen}
          saveAction={setNearlyFullPct}
        />
      </>
    );
  }

  const nowMs = DateTime.now().toMillis();
  const todayIso = DateTime.fromMillis(nowMs, { zone: BUSINESS_ZONE }).toISODate()!;
  const picked = sp.day && /^\d{4}-\d{2}-\d{2}$/.test(sp.day) && DateTime.fromISO(sp.day).isValid ? sp.day : null;
  const pickedPast = picked !== null && picked < todayIso ? picked : null;

  const [report, nearlyFullPct, hours, savedDays, pastAdvisors, paceRead] = await Promise.all([
    loadTeamCapacity({ orgId: me.org_id, now: new Date(nowMs), extraDay: pickedPast ? null : picked }),
    readNearlyFullPct(),
    loadBusinessHours().catch((err: unknown) => {
      log.error("team-capacity", { msg: "office hours read failed for the date picker" }, err);
      return null;
    }),
    readSavedDays(me.org_id, EVERY_SAVED_DAY_FROM).catch((err: unknown) => {
      log.error("team-capacity", { msg: "saved days read failed" }, err);
      return null;
    }),
    pickedPast
      ? loadCapacityHistoryDay(me.org_id, pickedPast).catch((err: unknown) => {
          log.error("team-capacity", { msg: "past day read failed", day: pickedPast }, err);
          return null;
        })
      : Promise.resolve(null),
    // The booking pace (#4104): a failure is one line under the cards, never the whole page.
    readPaceRows(me.org_id).catch((err: unknown): PaceRead => ({ ok: false, err })),
  ]);
  if (!report.measurable) return refused(UNMEASURABLE_COPY[report.reason]);
  if (nearlyFullPct === null) return refused(LINE_UNREADABLE_COPY);
  // The picker, a past day and the office's hours each say they failed rather than show less.
  if (hours === null) return refused(UNMEASURABLE_COPY["business-hours"]);
  if (savedDays === null || (pickedPast !== null && pastAdvisors === null)) return refused(HISTORY_UNREADABLE_COPY);

  const pickable = pickableDays({
    todayIso,
    zone: report.zone,
    aheadDays: BUSY_WINDOW_AHEAD_DAYS,
    saved: savedDays,
    isOpen: (iso, weekday) => windowOnDate(hours, iso, weekday) !== null,
  });
  // A past day opens only when the picker would offer it, so an address typed by hand cannot reach
  // a day history holds only part of (the first) or that the office was shut.
  const pastOffered = pickedPast !== null && pickable.includes(pickedPast) && pastAdvisors !== null && pastAdvisors.length > 0;
  const sources = daySources(report, pickedPast, pastOffered ? pastAdvisors : null);
  // Once every shift today is over, the Today card says how the day ended, from the saved history
  // (#4127). Read only then. A failed read is logged and the card says Done for today alone.
  const todayEnded = todayHasEnded(sources.find((s) => s.iso === todayIso), todayIso)
    ? await loadCapacityHistoryDay(me.org_id, todayIso).then(
        (advisors) => {
          const t = dayTotals(advisors.map((a) => ({ unsynced: a.unsynced, days: [a.days[0]] })), 0);
          return { open: t.open, fullPct: t.fullPct };
        },
        (err: unknown) => {
          log.error("team-capacity", { msg: "today's history read failed", day: todayIso }, err);
          return null;
        },
      )
    : undefined;
  // A day the picker would not offer (nothing saved, history's partly recorded first day, a day the
  // office was shut, or past the cached calendars) opens on the default day instead, and says
  // nothing: the picker never offered it.
  const pickedIndex = picked ? sources.findIndex((s) => s.iso === picked) : -1;
  if (picked && pickedIndex < 0) log.info("team-capacity", { msg: "picked day not offered", day: picked });
  // The page opens on tomorrow (D12), found by date: after the booker's evening cutoff the window
  // starts tomorrow, and a fixed position would open on the day after.
  const tomorrowIso = DateTime.fromISO(todayIso, { zone: report.zone }).plus({ days: 1 }).toISODate()!;
  const tomorrowIndex = sources.findIndex((s) => s.iso === tomorrowIso);
  const initialIndex = pickedIndex >= 0 ? pickedIndex : tomorrowIndex >= 0 ? tomorrowIndex : 0;
  // A failed read, or a row the page cannot read, is said under the cards (decision 12) and logged.
  const pace = judgePace(paceRead, nowMs);
  if (pace.kind === "failed") log.error("team-capacity", { msg: "booking pace read failed" }, pace.err);

  return (
    <>
      {header}
      <TeamCapacityView
        // Every load from the server starts the screen afresh: a picked date opens on that day
        // rather than keeping the one selected before, and a saved line closes its form.
        key={`${sources.map((s) => s.iso).join(",")}|${initialIndex}|${nowMs}`}
        view={teamCapacityView({ zone: report.zone, todayIso, nowMs, durationMin: report.eventType.duration_min, nearlyFullPct, days: sources, pace, todayEnded })}
        zone={report.zone}
        todayIso={todayIso}
        initialIndex={initialIndex}
        nearlyFullPct={nearlyFullPct}
        canEdit={canEdit}
        pickable={pickable}
        saveAction={setNearlyFullPct}
      />
    </>
  );
}

/** The window's days from the report, then the picked day: a coming one from the report, a past one from history. */
function daySources(report: Extract<TeamCapacityReport, { measurable: true }>, pickedPast: string | null, pastAdvisors: TeamCapacityAdvisor[] | null): CapacityDaySource[] {
  const sources = report.days.map((iso, i): CapacityDaySource => ({
    iso,
    kind: report.windowDays.includes(iso) ? "window" : "beyond",
    advisors: report.advisors.map((a) => ({ advisor: a, day: a.days[i] })),
  }));
  if (pickedPast && pastAdvisors) {
    sources.push({ iso: pickedPast, kind: "past", advisors: pastAdvisors.map((a) => ({ advisor: a, day: a.days[0] })) });
  }
  return sources;
}

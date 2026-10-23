/**
 * The design's fixture as the Team capacity page renders it (#3936, claude-config#1364).
 *
 * The settled design (docs/design/team-capacity.html) draws ten frames from one snapshot,
 * docs/design/fixtures/team-capacity.json, some with an illustration applied (a calendar not
 * syncing, an hour off, a full day, a picked date). The page's fixture preview renders the real
 * component from the same data with the same illustrations, so the design match score compares
 * like with like. This module is the one place the page applies those illustrations; the design's
 * checks (docs/design/team-capacity.checks.js) apply them again in the browser, and
 * scripts/test-design-checks-frame-view.ts holds that copy to this one.
 *
 * Pure (JSON in and out, the picker rule from team-capacity-view). Only ever reached behind the
 * fixture flag.
 */
import type { AdvisorDay, CapacityEventType, TeamCapacityAdvisor } from "./team-capacity";
import type { TeamCapacityReport } from "./team-capacity-load";
import { dayTotals } from "./team-capacity";
import { pickableDays } from "./team-capacity-view";
import type { PaceRead, PaceRow } from "./team-capacity-pace";

/** A day's stored pace reading, as the fixture writes it: the row less its day and read_at. */
export type FixturePaceReading = Omit<PaceRow, "day" | "read_at">;

export interface FixtureDay {
  iso: string;
  open: number;
  capacity: number;
  out: boolean;
  openTimes: string[];
  shiftStart: string | null;
  shiftEnd: string | null;
  fullShiftStart: string | null;
  fullShiftEnd: string | null;
}

export interface FixtureFrame {
  theme: "light" | "dark";
  day?: number;
  examples?: boolean;
  /**
   * today-full empties today's open calls; today-ended runs every shift today out, as at 10 PM;
   * nobody-on-shift leaves Wednesday with everyone out or with no shift (#4127).
   */
  illustrate?: "today-full" | "today-ended" | "nobody-on-shift";
  /** Today's saved history once every shift has ended: the team's unused calls and capacity (#4127). */
  todayHistory?: { open: number; capacity: number };
  pick?: string;
  calendarOpen?: boolean;
  changeOpen?: boolean;
  failed?: boolean;
  /** This frame's own pace readings, replacing the fixture's by day index (#4101). */
  pace?: Record<string, FixturePaceReading>;
  /** When this frame's readings were taken, in place of the fixture's. */
  paceReadAt?: string;
  /** The pace read fails on this frame. */
  paceFailed?: boolean;
}

export interface DesignFixtureFile {
  nearlyFullPct: number;
  examples: { unsynced: string; timeOff: { advisor: string; dayIndex: number; start: string; end: string } };
  /** The date picker's world: the office's closed weekday, and the first day history saved. */
  picker: { closedWeekday: number; savedFrom: string; aheadDays: number };
  /** Each day's latest booking pace reading, one per snapshot day, read at `readAt` (#4101). */
  pace: { readAt: string; days: FixturePaceReading[] };
  frames: Record<string, FixtureFrame>;
  snapshot: {
    takenAt: string;
    zone: string;
    offeredOpenDays: number;
    eventType: Omit<CapacityEventType, "daily_cap"> & { daily_cap?: number | null };
    days: string[];
    advisors: { name: string; timezone: string; days: FixtureDay[] }[];
  };
}

/** What the page needs to draw one frame: the report, the line, and the state it opens in. */
export interface FixtureView {
  report: TeamCapacityReport;
  nearlyFullPct: number;
  theme: "light" | "dark";
  dayIndex: number;
  calendarOpen: boolean;
  changeOpen: boolean;
  /** The illustrated not syncing advisor, for the scorer's expected totals. */
  unsynced: string[];
  /** The days the date picker offers. */
  pickable: string[];
  /** The booking pace read, as the live page would have it. */
  pace: PaceRead;
  /** Today's saved totals for a finished today, as the page reads them from history (#4127). */
  todayEnded?: { open: number; fullPct: number | null };
}

function stampMs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`the fixture holds an unreadable time: "${iso}"`);
  return ms;
}

/** One frame of the design, as data. Throws on a frame the fixture does not name. */
export function fixtureView(fixture: DesignFixtureFile, frameId: string): FixtureView {
  const frame = fixture.frames[frameId];
  if (!frame) throw new Error(`the fixture names no frame "${frameId}"`);
  const snap = fixture.snapshot;
  const callMin = snap.eventType?.duration_min;
  if (!Number.isFinite(callMin) || callMin <= 0) throw new Error("the fixture's snapshot carries no call length (eventType.duration_min)");
  const callMs = callMin * 60_000;
  const unsynced = frame.examples ? [fixture.examples.unsynced] : [];

  const advisors: TeamCapacityAdvisor[] = snap.advisors.map((a) => {
    let days: AdvisorDay[] = a.days.map((d) => ({ ...d, noShift: d.fullShiftStart === null, timeOff: [] }));
    if (frame.examples && a.name === fixture.examples.timeOff.advisor) {
      const t = fixture.examples.timeOff;
      const s0 = stampMs(t.start);
      const s1 = stampMs(t.end);
      days = days.map((d, i) => {
        if (i !== t.dayIndex) return d;
        const openTimes = d.openTimes.filter((x) => stampMs(x) + callMs <= s0 || stampMs(x) >= s1);
        return { ...d, openTimes, open: openTimes.length, timeOff: [{ start: t.start, end: t.end }] };
      });
    }
    if (frame.illustrate === "today-full") days = days.map((d, i) => (i === 0 ? { ...d, open: 0, openTimes: [] } : d));
    // Every shift today over: nothing ahead, though the day's shift is still known (#4127).
    if (frame.illustrate === "today-ended") days = days.map((d, i) => (i === 0 ? { ...d, open: 0, capacity: 0, openTimes: [], shiftStart: null, shiftEnd: null } : d));
    // Wednesday with nobody working: everyone not out has no shift that day (#4127).
    if (frame.illustrate === "nobody-on-shift") {
      days = days.map((d, i) => (i === 2 && !d.out ? { ...d, open: 0, capacity: 0, openTimes: [], noShift: true, shiftStart: null, shiftEnd: null, fullShiftStart: null, fullShiftEnd: null } : d));
    }
    // A picked date shows the window's last day under the picked date: nothing was stored for
    // other days when the design was drawn.
    if (frame.pick) days = [...days, { ...days[days.length - 1], iso: frame.pick }];
    return {
      id: a.name,
      name: a.name,
      email: `${a.name.toLowerCase().replace(/[^a-z]+/g, ".")}@fixture.invalid`,
      timezone: a.timezone,
      unsynced: unsynced.includes(a.name),
      days,
    };
  });

  // A snapshot records only the page's days; the booker's are the same list here, since only
  // the calendars filling up notice reads them and nothing judges it on a design fixture.
  const windowDays = snap.days;
  const days = frame.pick ? [...windowDays, frame.pick] : windowDays;
  const eventType: CapacityEventType = { ...snap.eventType, daily_cap: snap.eventType.daily_cap ?? null };
  const report: TeamCapacityReport = frame.failed
    ? { measurable: false, reason: "calendars" }
    : { measurable: true, nowMs: stampMs(snap.takenAt), zone: snap.zone, windowDays, bookerDays: windowDays, days, eventType, advisors };
  return {
    report,
    nearlyFullPct: fixture.nearlyFullPct,
    theme: frame.theme,
    dayIndex: frame.pick ? days.length - 1 : (frame.day ?? 1),
    calendarOpen: !!frame.calendarOpen,
    changeOpen: !!frame.changeOpen,
    unsynced,
    pickable: fixturePickable(fixture),
    pace: fixturePace(fixture, frame),
    // The page works today's percent out of its saved history the way it does every day's.
    todayEnded: frame.todayHistory ? (({ open, fullPct }) => ({ open, fullPct }))(dayTotals([{ unsynced: false, days: [{ ...frame.todayHistory, out: false }] }], 0)) : undefined,
  };
}

/** The frame's pace readings as the read returns them: every snapshot day, read at one instant. */
function fixturePace(fixture: DesignFixtureFile, frame: FixtureFrame): PaceRead {
  if (frame.paceFailed) return { ok: false, err: new Error("the design frame pretends the pace read failed") };
  const readAt = frame.paceReadAt ?? fixture.pace.readAt;
  const rows = fixture.snapshot.days.map((day, i): PaceRow => ({ ...(frame.pace?.[String(i)] ?? fixture.pace.days[i]), day, read_at: readAt }));
  return { ok: true, rows };
}

/** Every day from the fixture's first saved day to the day before it was taken counts as saved. */
function fixturePickable(fixture: DesignFixtureFile): string[] {
  const { closedWeekday, savedFrom, aheadDays } = fixture.picker;
  const todayIso = fixture.snapshot.days[0];
  const saved: string[] = [];
  for (let ms = Date.parse(`${savedFrom}T12:00:00Z`); ; ms += 86_400_000) {
    const iso = new Date(ms).toISOString().slice(0, 10);
    if (iso >= todayIso) break;
    saved.push(iso);
  }
  return pickableDays({ todayIso, zone: fixture.snapshot.zone, aheadDays, saved, isOpen: (_iso, weekday) => weekday !== closedWeekday });
}

/**
 * Whether the page may answer `?frame=` from the design's fixture: only when the e2e run set the
 * flag AND the request is to this machine, so a deploy that somehow carried the flag still never
 * serves invented numbers to anybody.
 */
export function designFixturesEnabled(flag: string | undefined, host: string | null): boolean {
  if (flag !== "1" || !host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

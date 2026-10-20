/**
 * The design's fixture as the Team capacity page renders it (#3936, claude-config#1364).
 *
 * The settled design (docs/design/team-capacity.html) draws ten frames from one snapshot,
 * docs/design/fixtures/team-capacity.json, some with an illustration applied (a calendar not
 * syncing, an hour off, a full day, a picked date). The page's fixture preview renders the real
 * component from the same data with the same illustrations, so the design match score compares
 * like with like. This module is the one place those illustrations are applied; the scorer's
 * expected numbers come from here too (scripts/lib/design-match.ts).
 *
 * Pure (luxon free, JSON in and out). Only ever reached behind `designFixturesEnabled`.
 */
import type { AdvisorDay, CapacityEventType, TeamCapacityAdvisor } from "./team-capacity";
import type { TeamCapacityReport } from "./team-capacity-load";

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
  illustrate?: "today-full";
  pick?: string;
  calendarOpen?: boolean;
  changeOpen?: boolean;
  failed?: boolean;
}

export interface DesignFixtureFile {
  nearlyFullPct: number;
  examples: { unsynced: string; timeOff: { advisor: string; dayIndex: number; start: string; end: string } };
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

  const windowDays = snap.days;
  const days = frame.pick ? [...windowDays, frame.pick] : windowDays;
  const eventType: CapacityEventType = { ...snap.eventType, daily_cap: snap.eventType.daily_cap ?? null };
  const report: TeamCapacityReport = frame.failed
    ? { measurable: false, reason: "calendars" }
    : { measurable: true, nowMs: stampMs(snap.takenAt), zone: snap.zone, windowDays, days, eventType, advisors };
  return {
    report,
    nearlyFullPct: fixture.nearlyFullPct,
    theme: frame.theme,
    dayIndex: frame.pick ? days.length - 1 : (frame.day ?? 1),
    calendarOpen: !!frame.calendarOpen,
    changeOpen: !!frame.changeOpen,
    unsynced,
  };
}

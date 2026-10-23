/**
 * What the Team capacity page draws (#3936), worked out from the report so the component only lays
 * it out. Every rule here is the settled design's (docs/design/team-capacity.html), and the design
 * match score holds the page to it picture by picture; scripts/test-team-capacity-view.ts holds the
 * rules a picture cannot name.
 *
 * Pure: luxon only.
 */
import { DateTime } from "luxon";
import { dayFlag, dayTotals, type AdvisorDay, type TeamCapacityAdvisor } from "./team-capacity";
import {
  AXIS_END_HOUR,
  AXIS_START_HOUR,
  BEYOND_WINDOW_NOTE,
  NOT_SYNCING_TAG,
  OUT_WORDS,
  axisLabel,
  calendarHref,
  callsOpenUnit,
  dayLabel,
  noShiftWords,
  pastDaySummary,
  pickedDayLabel,
  zoneShort,
  advisorsOffLine,
  calendarsNotSyncingLine,
  DONE_FOR_TODAY,
  NO_ONE_ON_SHIFT,
  unbookedLine,
  paceStaleSentence,
  PACE_UNREADABLE_COPY,
} from "./team-capacity-copy";
import { cardPaceLines, type PaceView } from "./team-capacity-pace";

/** A left and width along the axis, in percent. */
export interface Span {
  left: number;
  width: number;
}

/**
 * What a day card is (#4127): an ordinary day; today once every shift has ended; a day everyone
 * is out or has no shift; or a day nobody can be counted on for any other reason (only calendars
 * that are not syncing left, or time off filling every shift that is left).
 */
export type CapacityCardKind = "open" | "ended" | "no-shift" | "nobody-counted";

export interface CapacityCard {
  iso: string;
  kind: CapacityCardKind;
  /** Words drawn in place of the calls open number: Done for today on a finished day. */
  headline: string | null;
  /** The line under the number or headline: the calls a finished day left unused, or No one on shift. */
  resultLine: string | null;
  top: string;
  sub: string;
  open: number;
  unit: string;
  /** Share of capacity used, or null when nobody on the day could be counted. */
  fullPct: number | null;
  flag: "full" | "nearly-full" | null;
  out: number;
  notCounted: number;
  /** How fast the day is filling, pace first (#4101); none while the line under the cards stands in. */
  pace: string[];
  /** The time off line, `6 advisors off`, or null with nobody off. */
  outLine: string | null;
  /** The not syncing line, `1 calendar not syncing`, or null with every calendar syncing. */
  notSyncingLine: string | null;
}

export interface CapacityTab {
  iso: string;
  label: string;
  /** Flag colouring; never on a picked day, whose numbers are not the window's. */
  flag: "full" | "nearly-full" | null;
  /** The dot before the label, at or over the line. */
  dot: boolean;
}

export interface CapacityRow {
  id: string;
  name: string;
  zone: string;
  calendarHref: string;
  unsynced: boolean;
  /** The whole day in words on a grey bar (Out, No shift), drawn in place of everything else. */
  whole: string | null;
  gone: Span | null;
  taken: Span | null;
  timeOff: Span[];
  open: Span[];
  /** A saved past day's open calls, drawn the same and named apart. */
  past: boolean;
  /** The Open column; blank for a day nobody can measure or that holds no shift. */
  count: string;
  countZero: boolean;
  tag: string | null;
}

export interface CapacityDayView {
  iso: string;
  note: string | null;
  /** Where now falls on today's axis, in percent; null on every other day. */
  nowPos: number | null;
  rows: CapacityRow[];
}

export interface CapacityTick {
  label: string;
  left: number;
  last: boolean;
  hidden: boolean;
}

/** One day's advisors: the window's days come from the report, a picked day from history or the report. */
export interface CapacityDaySource {
  iso: string;
  kind: "window" | "beyond" | "past";
  advisors: { advisor: TeamCapacityAdvisor; day: AdvisorDay }[];
}

export interface TeamCapacityViewInput {
  zone: string;
  todayIso: string;
  nowMs: number;
  durationMin: number;
  nearlyFullPct: number;
  /** The booking pace readings, judged (`judgePace`). */
  pace: PaceView;
  /** The window's days, then the picked day when there is one. */
  days: CapacityDaySource[];
  /**
   * Today's totals from the saved history, read once every shift today has ended (#4127): the
   * calls left unused and how full it ended. Null when that read failed; absent when not read.
   */
  todayEnded?: { open: number; fullPct: number | null } | null;
}

export interface TeamCapacityView {
  cards: CapacityCard[];
  tabs: CapacityTab[];
  days: CapacityDayView[];
  /**
   * The one line under the cards when the pace cannot be shown (#4101, decisions 12 and 13): the
   * lead in the error colour, then the muted rest. Null while the cards show it themselves.
   */
  paceNotice: { lead: string; rest: string | null } | null;
  /** Ticks for each day, keyed by index: today hides the ones under the Now label. */
  ticks: CapacityTick[][];
}

const SPAN_MIN = (AXIS_END_HOUR - AXIS_START_HOUR) * 60;

/** Where an instant falls on the office day's axis, by its time of day in the office's zone. */
export function axisPos(iso: string, zone: string): number {
  const t = DateTime.fromISO(iso, { zone });
  return (100 * (t.hour * 60 + t.minute - AXIS_START_HOUR * 60)) / SPAN_MIN;
}

function totalsFor(source: CapacityDaySource) {
  return dayTotals(
    source.advisors.map((a) => ({ unsynced: a.advisor.unsynced, days: [a.day] })),
    0,
  );
}

/**
 * Which kind of card a window day is (#4127). Capacity counts only time still ahead, so on today a
 * capacity of zero with someone counted who had a shift means every shift is over, not that nobody
 * could be counted. Out and not syncing advisors are never counted.
 */
export function cardKind(source: CapacityDaySource, todayIso: string): CapacityCardKind {
  const counted = source.advisors.filter((a) => !a.advisor.unsynced && !a.day.out);
  if (counted.some((a) => a.day.capacity > 0)) return "open";
  if (source.iso === todayIso && counted.some((a) => !a.day.noShift)) return "ended";
  const unsynced = source.advisors.some((a) => a.advisor.unsynced);
  if (!unsynced && counted.every((a) => a.day.noShift)) return "no-shift";
  return "nobody-counted";
}

/** Whether today's card needs the saved history: every shift today is over (#4127). */
export function todayHasEnded(source: CapacityDaySource | undefined, todayIso: string): boolean {
  return source !== undefined && source.kind === "window" && cardKind(source, todayIso) === "ended";
}

export function teamCapacityView(input: TeamCapacityViewInput): TeamCapacityView {
  const { zone, todayIso, nearlyFullPct } = input;
  const callWidth = (100 * input.durationMin) / SPAN_MIN;
  const window = input.days.filter((d) => d.kind === "window");

  const cards: CapacityCard[] = window.map((source) => {
    const t = totalsFor(source);
    const l = dayLabel(source.iso, todayIso, zone);
    const kind = cardKind(source, todayIso);
    if (kind === "ended") {
      // Figures only from a read that found the day: a failed or empty read says Done for today alone.
      const ended = input.todayEnded && input.todayEnded.fullPct !== null ? input.todayEnded : null;
      return {
        iso: source.iso,
        kind,
        headline: DONE_FOR_TODAY,
        resultLine: ended ? unbookedLine(ended.open) : null,
        top: l.top,
        sub: l.sub,
        open: 0,
        unit: "",
        fullPct: ended ? ended.fullPct : null,
        // A finished day can take no more calls, so it is never flagged, and has nothing left to fill.
        flag: null,
        out: t.out,
        notCounted: t.notCounted,
        pace: [],
        outLine: t.out > 0 ? advisorsOffLine(t.out) : null,
        notSyncingLine: t.notCounted > 0 ? calendarsNotSyncingLine(t.notCounted) : null,
      };
    }
    if (kind === "no-shift") {
      // Said once: no time off line beside it, no bar, no pace (Dan, 2026-10-22, #4101 decision 17).
      return {
        iso: source.iso,
        kind,
        headline: null,
        resultLine: NO_ONE_ON_SHIFT,
        top: l.top,
        sub: l.sub,
        open: 0,
        unit: callsOpenUnit(0),
        fullPct: null,
        flag: null,
        out: t.out,
        notCounted: 0,
        pace: [],
        outLine: null,
        notSyncingLine: null,
      };
    }
    return {
      iso: source.iso,
      kind,
      headline: null,
      resultLine: null,
      top: l.top,
      sub: l.sub,
      open: t.open,
      unit: callsOpenUnit(t.open),
      fullPct: t.fullPct,
      flag: dayFlag(t, nearlyFullPct),
      out: t.out,
      notCounted: t.notCounted,
      pace: input.pace.kind === "fresh" ? cardPaceLines(input.pace.byDay.get(source.iso), t.fullPct, zone, todayIso) : [],
      outLine: t.out > 0 ? advisorsOffLine(t.out) : null,
      notSyncingLine: t.notCounted > 0 ? calendarsNotSyncingLine(t.notCounted) : null,
    };
  });

  const tabs: CapacityTab[] = input.days.map((source) => {
    const t = totalsFor(source);
    const l = source.kind === "window" ? dayLabel(source.iso, todayIso, zone) : pickedDayLabel(source.iso, zone);
    return {
      iso: source.iso,
      label: `${l.top}, ${l.sub}`,
      flag: source.kind === "window" ? dayFlag(t, nearlyFullPct) : null,
      dot: t.fullPct !== null && t.fullPct >= nearlyFullPct,
    };
  });

  const nowPos = axisPos(new Date(input.nowMs).toISOString(), zone);
  const baseTicks: CapacityTick[] = [];
  for (let h = AXIS_START_HOUR; h <= AXIS_END_HOUR; h++) {
    baseTicks.push({ label: axisLabel(h), left: (100 * (h - AXIS_START_HOUR) * 60) / SPAN_MIN, last: h === AXIS_END_HOUR, hidden: false });
  }

  const days: CapacityDayView[] = input.days.map((source) => {
    const isToday = source.iso === todayIso;
    const now = isToday ? nowPos : null;
    let note: string | null = null;
    if (source.kind === "beyond") note = BEYOND_WINDOW_NOTE;
    if (source.kind === "past") {
      const t = totalsFor(source);
      note = pastDaySummary(t.fullPct, t.open);
    }
    const rows = [...source.advisors]
      .sort((a, b) => a.advisor.name.localeCompare(b.advisor.name))
      .map(({ advisor: a, day: d }): CapacityRow => {
        const wholeDay = !a.unsynced && (d.out || d.fullShiftStart === null);
        const row: CapacityRow = {
          id: a.id,
          name: a.name,
          zone: zoneShort(a.timezone),
          calendarHref: calendarHref(a.email, source.iso, zone),
          unsynced: a.unsynced,
          whole: wholeDay ? (d.out ? OUT_WORDS : noShiftWords(isToday)) : null,
          gone: null,
          taken: null,
          timeOff: [],
          open: [],
          past: source.kind === "past",
          count: a.unsynced || d.out || d.capacity === 0 ? "" : String(d.open),
          countZero: d.open === 0,
          tag: a.unsynced ? NOT_SYNCING_TAG : null,
        };
        if (wholeDay) return row;
        if (now !== null && d.fullShiftStart !== null && d.fullShiftEnd !== null) {
          const f0 = axisPos(d.fullShiftStart, zone);
          row.gone = { left: f0, width: Math.max(0, Math.min(axisPos(d.fullShiftEnd, zone), now) - f0) };
        }
        // A shift already over today has nothing left to draw but its gone hours.
        if (d.shiftStart !== null && d.shiftEnd !== null) {
          const s0 = axisPos(d.shiftStart, zone);
          row.taken = { left: s0, width: axisPos(d.shiftEnd, zone) + callWidth - s0 };
        }
        row.timeOff = d.timeOff.map((o) => {
          const left = axisPos(o.start, zone);
          return { left, width: axisPos(o.end, zone) - left };
        });
        row.open = d.openTimes.map((t) => ({ left: axisPos(t, zone), width: callWidth }));
        return row;
      });
    return { iso: source.iso, note, nowPos: now, rows };
  });

  const ticks = days.map((d) =>
    d.nowPos === null ? baseTicks : baseTicks.map((t) => ({ ...t, hidden: Math.abs(t.left - d.nowPos!) < 4.5 })),
  );
  const paceNotice =
    input.pace.kind === "failed"
      ? { lead: PACE_UNREADABLE_COPY.heading, rest: PACE_UNREADABLE_COPY.body }
      : input.pace.kind === "stale"
        ? { lead: paceStaleSentence(input.pace.sinceMs, zone, todayIso), rest: null }
        : null;
  return { cards, tabs, days, paceNotice, ticks };
}

export interface PickableInput {
  todayIso: string;
  zone: string;
  /** How far ahead a day can be picked: as far as cached calendar time reaches. */
  aheadDays: number;
  /** Every past day history holds, from its very first (`EVERY_SAVED_DAY_FROM`). */
  saved: string[];
  /** Whether the office is open that day (`windowOnDate`), past and future alike. */
  isOpen: (iso: string, weekday: number) => boolean;
}

/**
 * The days the date picker offers, ascending: a past day only when history saved it (Dan,
 * 2026-10-19), a coming day only as far ahead as calendars are cached, and never a closed day.
 *
 * Never the first day history saved: the recorder's first run saves nothing and its second covers
 * only the rest of that day, so the calls that passed earlier were never saved as open and the day
 * would read nearly full. Every later day is covered from its start.
 */
export function pickableDays(input: PickableInput): string[] {
  const today = DateTime.fromISO(input.todayIso, { zone: input.zone }).startOf("day");
  const open = (d: DateTime) => input.isOpen(d.toISODate()!, d.weekday);
  const past = [...new Set(input.saved)]
    .sort()
    .slice(1)
    .filter((iso) => iso < input.todayIso)
    .filter((iso) => open(DateTime.fromISO(iso, { zone: input.zone })));
  const coming: string[] = [];
  for (let i = 0; i <= input.aheadDays; i++) {
    const d = today.plus({ days: i });
    if (open(d)) coming.push(d.toISODate()!);
  }
  return [...past, ...coming];
}

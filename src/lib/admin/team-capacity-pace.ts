/**
 * The booking pace on Team capacity's day cards (#4104, the design settled in #4101): what each
 * card says about how fast its day is filling, from that day's latest reading in
 * capacity_fill_readings (#4102), whose pace and estimate columns the capacity-fill lane works out
 * (#4103, src/lib/admin/capacity-pace.ts).
 *
 * Three outcomes for the read as a whole, each said once and never as a blank or a zero:
 * - fresh: the latest run's readings, one per day it read; a card whose day it did not read, or
 *   when there are no readings at all (launch), says the pace is coming;
 * - stale: the latest reading is older than the lane's own stale bound, so ONE line under the cards
 *   says since when, and the cards drop their pace lines (decision 13);
 * - failed: the read failed, or a row holds something this page cannot read (an unknown state, an
 *   unparseable number or time, L50), so ONE line under the cards says so (decision 12). A guess is
 *   never drawn, and the rest of the page still renders.
 *
 * Pure: luxon and the copy module only.
 */
import { LANE_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import {
  NO_PACE_YET,
  NOT_FILLING,
  estimateLine,
  paceRateLine,
  readingsMissedLine,
} from "./team-capacity-copy";

/** Full by, as the cards mean it: this share of the day's capacity used (capacity-pace's FULL_BY_PCT). */
export const PACE_ESTIMATE_PCT = 95;

/** The columns the page reads, as capacity_fill_readings stores them. */
export const PACE_COLUMNS =
  "day, read_at, pace_state, pace_per_hour, pace_back_at, estimate_method, estimate_line_state, estimate_line_at, estimate_pattern_state, estimate_pattern_at, " +
  "estimate_last_method, estimate_last_line_state, estimate_last_line_at, estimate_last_pattern_state, estimate_last_pattern_at";

/** One stored reading, as read. `pace_back_at` is the half hour a missed pace returns (#4103). */
export interface PaceRow {
  day: string;
  read_at: string;
  /** Null on a reading the lane has not worked a pace out for. */
  pace_state: string | null;
  /** numeric: a number, or text when PostgREST returns it so. */
  pace_per_hour: number | string | null;
  pace_back_at: string | null;
  estimate_method: string | null;
  estimate_line_state: string | null;
  estimate_line_at: string | null;
  estimate_pattern_state: string | null;
  estimate_pattern_at: string | null;
  /** From 95%, when the last open call is taken (#4190); null under 95% and before 0204. */
  estimate_last_method: string | null;
  estimate_last_line_state: string | null;
  estimate_last_line_at: string | null;
  estimate_last_pattern_state: string | null;
  estimate_last_pattern_at: string | null;
}

/** The read: its rows, or that it failed. */
export type PaceRead = { ok: true; rows: PaceRow[] } | { ok: false; err?: unknown };

export type PaceEstimate =
  | { state: "at"; atMs: number }
  /** The walk reached the day's last bookable moment short of its target. */
  | { state: "wont-fill" }
  /** Already at the target, no rate to walk with, or nobody counted: no estimate line. */
  | { state: "none" };

/** An estimate with the method that made it, null when the reading has no method. */
export type ShownEstimate = { method: "line" | "pattern"; estimate: PaceEstimate } | null;

export type DayPace =
  | {
      state: "pace";
      perHour: number;
      /** To 95% full. */
      fullBy: ShownEstimate;
      /** From 95%, to no call open (#4190, decision 20); null on a reading without one. */
      lastCall: ShownEstimate;
    }
  | { state: "not-filling" }
  | { state: "no-pace-yet" }
  | { state: "readings-missed"; backAtMs: number };

export type PaceView =
  | { kind: "fresh"; byDay: Map<string, DayPace> }
  | { kind: "stale"; sinceMs: number }
  | { kind: "failed"; err?: unknown };

const PACE_STATES = new Set(["pace", "not-filling", "no-pace-yet", "readings-missed"]);
const ESTIMATE_STATES = new Set(["at", "wont-fill", "already", "no-pace", "no-capacity"]);

function instant(iso: string | null, what: string): number {
  const ms = iso === null ? NaN : Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`${what} is not a readable instant: "${iso}"`);
  return ms;
}

function estimateOf(state: string | null, at: string | null, what: string): PaceEstimate {
  if (state === null) return { state: "none" };
  if (!ESTIMATE_STATES.has(state)) throw new Error(`${what} has an unknown state "${state}"`);
  if (state === "at") return { state: "at", atMs: instant(at, `${what}'s time`) };
  return state === "wont-fill" ? { state: "wont-fill" } : { state: "none" };
}

/** One stored reading as the card reads it; anything it cannot read throws. */
function dayPaceOf(r: PaceRow): DayPace {
  const what = `the pace reading for ${r.day}`;
  // Both methods are checked, though only one is shown, so a broken column is found the day it ships.
  const line = estimateOf(r.estimate_line_state, r.estimate_line_at, `${what}'s straight line`);
  const pattern = estimateOf(r.estimate_pattern_state, r.estimate_pattern_at, `${what}'s pattern`);
  if (r.pace_state === null || r.pace_state === "no-pace-yet") return { state: "no-pace-yet" };
  if (!PACE_STATES.has(r.pace_state)) throw new Error(`${what} has an unknown pace state "${r.pace_state}"`);
  if (r.pace_state === "not-filling") return { state: "not-filling" };
  if (r.pace_state === "readings-missed") return { state: "readings-missed", backAtMs: instant(r.pace_back_at, `${what}'s return time`) };
  const perHour = r.pace_per_hour === null ? NaN : Number(r.pace_per_hour);
  if (!Number.isFinite(perHour)) throw new Error(`${what} has no readable pace: "${r.pace_per_hour}"`);
  const fullBy = shown(r.estimate_method, line, pattern, `${what}'s method`);
  const lastLine = estimateOf(r.estimate_last_line_state, r.estimate_last_line_at, `${what}'s last call straight line`);
  const lastPattern = estimateOf(r.estimate_last_pattern_state, r.estimate_last_pattern_at, `${what}'s last call pattern`);
  const lastCall = shown(r.estimate_last_method, lastLine, lastPattern, `${what}'s last call method`);
  return { state: "pace", perHour, fullBy, lastCall };
}

function shown(method: string | null, line: PaceEstimate, pattern: PaceEstimate, what: string): ShownEstimate {
  if (method === null) return null;
  if (method !== "line" && method !== "pattern") throw new Error(`${what} is unknown: "${method}"`);
  return { method, estimate: method === "line" ? line : pattern };
}

/**
 * The read as the page shows it at `nowMs`. Only the latest run's readings count: the lane writes
 * every page day in one run, so a day missing from it is a day it did not read.
 */
export function judgePace(read: PaceRead, nowMs: number, staleMs: number = LANE_STALE_BOUNDS_MS["capacity-fill"]): PaceView {
  if (!read.ok) return { kind: "failed", err: read.err };
  try {
    let newestMs = -Infinity;
    const stamped = read.rows.map((r) => {
      const readAtMs = instant(r.read_at, `the pace reading for ${r.day}'s read_at`);
      newestMs = Math.max(newestMs, readAtMs);
      return { r, readAtMs };
    });
    if (stamped.length === 0) return { kind: "fresh", byDay: new Map() };
    if (nowMs - newestMs > staleMs) return { kind: "stale", sinceMs: newestMs };
    const byDay = new Map<string, DayPace>();
    for (const { r, readAtMs } of stamped) if (readAtMs === newestMs) byDay.set(r.day, dayPaceOf(r));
    // Older rows are checked too: a malformed one is a contract fault worth saying, not skipping.
    for (const { r, readAtMs } of stamped) if (readAtMs !== newestMs) dayPaceOf(r);
    return { kind: "fresh", byDay };
  } catch (err) {
    return { kind: "failed", err };
  }
}

/**
 * A card's pace lines, pace first (decision 1). Under 95% the estimate is when the day reaches 95%;
 * from 95% it is when its last open call is taken (#4190, decision 20), and a day with no percent
 * shows the pace alone. Not filling, no pace yet and readings missed each stand in for both lines
 * (decisions 6 to 8; not filling reads Won't fill at this pace, decision 21).
 */
export function cardPaceLines(day: DayPace | undefined, fullPct: number | null, zone: string, todayIso: string): string[] {
  if (!day || day.state === "no-pace-yet") return [NO_PACE_YET];
  if (day.state === "not-filling") return [NOT_FILLING];
  if (day.state === "readings-missed") return [readingsMissedLine(day.backAtMs, zone, todayIso)];
  const out = [paceRateLine(day.perHour)];
  if (fullPct === null) return out;
  const shownEst = fullPct >= PACE_ESTIMATE_PCT ? day.lastCall : day.fullBy;
  if (shownEst === null || shownEst.estimate.state === "none") return out;
  out.push(estimateLine(shownEst.method, shownEst.estimate.state === "at" ? { atMs: shownEst.estimate.atMs } : "wont-fill", zone, todayIso));
  return out;
}

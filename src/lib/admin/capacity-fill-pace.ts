/**
 * Booking pace on Team capacity (#4103): each reading's pace and both estimates, written onto the
 * capacity_fill_readings row the capacity-fill lane is about to save, for the day cards (#4104).
 *
 * The rules live in capacity-pace.ts; this file only hands them what the lane already holds and
 * stores their answers as they are, so the card can never show a pace the module did not compute.
 *
 * ## What the pace is handed
 *
 * The day's stored readings from the last 3 hours (`PACE_HISTORY_MS`, the lane reads them) and the
 * reading being written now, so the half hour just measured counts at once. Their earliest instant
 * is what says whether 3 hours of readings exist.
 *
 * ## Which cell a step uses
 *
 * The one a reading at that instant would be stamped with: `officeSlot`, the stamp's own helper,
 * and the day's position among the booker's days as `capacityDays` gives them THEN. Tomorrow seen
 * tonight is the booker's second day; walked into tomorrow morning it is the first.
 *
 * Pure (luxon and the pure cores), so the test drives it node natively.
 */
import { DateTime } from "luxon";
import type { BusinessHoursRules } from "../availability/compute.ts";
import { capacityDays } from "./capacity-days.ts";
import type { FillReadingRow } from "./capacity-fill.ts";
import { officeSlot } from "./office-slot.ts";
import { estimate, pace, PACE_WINDOW_MS, walkAdvisorOf, type CellKey, type Estimate, type PaceReading, type PatternCell } from "./capacity-pace.ts";
import type { CapacityPeople } from "./team-capacity-load.ts";
import type { CapacityEventType } from "./team-capacity.ts";

/** How far back the lane reads a day's stored readings for its pace. */
export const PACE_HISTORY_MS = PACE_WINDOW_MS;

/**
 * How far back the pattern averages: six weeks, so a weekday's own cells can reach their floor of
 * six samples (PATTERN_WEEKDAY_MIN_SAMPLES) once that much history exists.
 */
export const PATTERN_LOOKBACK_MS = 42 * 24 * 3_600_000;

/** The cell a reading of `day` at `stepMs` would be stamped with. */
export function fillCellAt(stepMs: number, day: string, hours: BusinessHoursRules, eventType: CapacityEventType, offeredDays: number): CellKey {
  const { slotOfDay, weekday } = officeSlot(stepMs, hours.zone);
  const window = capacityDays(hours, stepMs, eventType.min_notice_min, offeredDays);
  const position = window ? window.bookerDays.indexOf(day) : -1;
  return { dayPosition: position === -1 ? null : position, slotOfDay, weekday };
}

export interface FillPaceInput {
  readAtMs: number;
  /** This reading's rows, as `fillReadings` made them. */
  rows: FillReadingRow[];
  /** Each day's stored readings since `readAtMs - PACE_HISTORY_MS`. */
  history: Map<string, PaceReading[]>;
  pattern: PatternCell[];
  people: CapacityPeople;
  hours: BusinessHoursRules;
  eventType: CapacityEventType;
  /** The booker's open days setting, for each step's day position. */
  offeredDays: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const iso = (ms: number) => new Date(ms).toISOString();
const stateOf = (e: Estimate) => ({ state: e.state, at: e.state === "at" ? iso(e.atMs) : null });

/** The rows with their pace and both estimates filled in. */
export function fillPace(input: FillPaceInput): FillReadingRow[] {
  const { readAtMs, people, hours, eventType } = input;
  const byId = new Map(people.members.map((m) => [m.userId, m]));
  return input.rows.map((row) => {
    const readings: PaceReading[] = [...(input.history.get(row.day) ?? []), { read_at: iso(readAtMs), prev_read_at: row.prev_read_at, taken: row.taken }];
    const p = pace(readings, readAtMs);
    const day = DateTime.fromISO(row.day, { zone: hours.zone }).startOf("day");
    const advisors = people.roster.map((u) => {
      const member = byId.get(u.id);
      // A missing row is an incomplete read, never an advisor with no room (see teamCapacityReport).
      if (!member) throw new Error(`the availability read returned no row for advisor ${u.id}`);
      return walkAdvisorOf({ member, timeOff: people.timeOff.get(u.id) ?? [], day, eventType, hours, nowMs: readAtMs }, people.failingEmails.has(u.email));
    });
    const est = estimate({
      readAtMs,
      advisors,
      eventType,
      pace: p,
      pattern: input.pattern,
      cellAt: (stepMs) => fillCellAt(stepMs, row.day, hours, eventType, input.offeredDays),
    });
    const line = stateOf(est.line);
    const pattern = stateOf(est.pattern);
    return {
      ...row,
      pace_state: p.state,
      pace_per_hour: p.state === "pace" || p.state === "not-filling" ? round2(p.perHour) : null,
      pace_back_at: p.state === "readings-missed" ? iso(p.backAtMs) : null,
      estimate_line_state: line.state,
      estimate_line_at: line.at,
      estimate_pattern_state: pattern.state,
      estimate_pattern_at: pattern.at,
      estimate_method: est.shown,
      estimate_cells_fallen_back: est.cellsFallenBack,
    };
  });
}

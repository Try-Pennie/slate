/**
 * Booking pace on Team capacity (#4103): how fast each page day is filling, and when it will reach
 * 95% full, worked out from the half hour readings (#4102) by two methods from day one.
 *
 * ## Pace
 *
 * Net calls taken over the KNOWN intervals of the last 3 hours, per hour. Each reading's taken is
 * already scaled to the counted team. An interval counts for the time it ran, so a reading after a
 * gap counts its hour and a half; one that began before the window is left out whole rather than
 * shared out by a guess. Under 2 known hours there is no pace: at launch, the night a new day joins
 * the window, and after a gap. At or under 0 the day is not filling, a state of its own.
 *
 * ## The estimate predicts the card's own percent
 *
 * The walk steps from the reading in half hours to the day's last bookable moment. At each step t,
 * every advisor's starts as seen now, cut to t plus notice and packed with `callsThatFit`, are the
 * open and capacity the card would show at t, unbooked times passing included. That shortcut is
 * the booker's rule: scripts/test-capacity-pace.ts holds it equal to `advisorDay` at nowMs = t.
 * The expected taken so far comes off the team's open (never below 0), and `dayTotals` judges the
 * percent, so there is no second formula. The first step at 95% or more is the time.
 *
 * ## Both methods, every reading
 *
 * The straight line expects the pace every hour. The pattern expects each half hour's average
 * taken for the day's place in the booker's days: a weekday's own cell from 6 samples, else the all
 * days cell from 10, else the straight line for that cell. Both are worked out on every reading,
 * so the switch never turns on code that has not run, and the pattern is the method shown only
 * when no cell it used fell back, so the card's "at this pace" is never wrong.
 *
 * Pure (the pure slot core, no clock of its own: every instant is passed in), so the test drives
 * it node natively.
 */
import {
  advisorDay,
  bookedOnDay,
  callsThatFit,
  dayTotals,
  openStartsAt,
  type AdvisorDayInput,
  type CapacityEventType,
} from "./team-capacity.ts";

/** How far back the pace looks. */
export const PACE_WINDOW_MS = 3 * 3_600_000;
/** The known time inside the window a pace needs. */
export const PACE_MIN_KNOWN_MS = 2 * 3_600_000;
/** Full by, as the card's words mean it: this share of the day's capacity used. */
export const FULL_BY_PCT = 95;
/** The walk's step, the readings' own cadence. */
export const WALK_STEP_MS = 30 * 60_000;
/** Samples an all days pattern cell needs before it is used (Dan, 2026-10-22). */
export const PATTERN_MIN_SAMPLES = 10;
/** Samples a weekday's own pattern cell needs to take over, about six weeks (Dan, 2026-10-22). */
export const PATTERN_WEEKDAY_MIN_SAMPLES = 6;

/** The reading fields the pace reads, as capacity_fill_readings stores them. */
export interface PaceReading {
  read_at: string;
  /** Null on a day's first reading. */
  prev_read_at: string | null;
  /** Calls taken since `prev_read_at`, scaled to the counted team; null when unknown. */
  taken: number | null;
}

export type Pace =
  | { state: "pace"; perHour: number; knownHours: number }
  /** At or under 0: nothing net is being taken. The number is kept for the record. */
  | { state: "not-filling"; perHour: number; knownHours: number }
  /** Under 2 known hours of the last 3. */
  | { state: "no-pace-yet"; knownHours: number };

/** One day's pace at `nowMs`, from that day's readings. */
export function pace(readings: PaceReading[], nowMs: number): Pace {
  const windowStart = nowMs - PACE_WINDOW_MS;
  let knownMs = 0, taken = 0;
  for (const r of readings) {
    if (r.taken === null || r.prev_read_at === null) continue;
    const from = Date.parse(r.prev_read_at);
    const to = Date.parse(r.read_at);
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error(`a capacity fill reading has an unreadable instant: ${r.prev_read_at} to ${r.read_at}`);
    if (from < windowStart || to > nowMs) continue;
    knownMs += to - from;
    taken += r.taken;
  }
  const knownHours = knownMs / 3_600_000;
  if (knownMs < PACE_MIN_KNOWN_MS) return { state: "no-pace-yet", knownHours };
  const perHour = taken / knownHours;
  return { state: perHour > 0 ? "pace" : "not-filling", perHour, knownHours };
}

/** One advisor on the walked day, as seen at the reading: everything the walk needs. */
export interface WalkAdvisor {
  /** Their calendar is not syncing, so `dayTotals` counts them in neither number. */
  unsynced: boolean;
  /** Time off covers their whole shift. */
  out: boolean;
  /** The booker's open starts, unpacked, against their calendar and time off. */
  openStarts: string[];
  /** The starts an empty calendar would offer, unpacked, time off taken out. */
  capacityStarts: string[];
  /** Calls already booked on the day, for a daily cap. */
  bookedOnDay: number;
}

/** An advisor's walk input from the same reads `advisorDay` takes, at the reading. */
export function walkAdvisorOf(input: AdvisorDayInput, unsynced: boolean): WalkAdvisor {
  return {
    unsynced,
    out: advisorDay(input).out,
    openStarts: openStartsAt(input),
    // An empty calendar and no bookings: the starts `advisorDay` packs into capacity.
    capacityStarts: openStartsAt({ ...input, member: { ...input.member, busy: [], dayCounts: new Map() } }),
    bookedOnDay: bookedOnDay(input.member, input.day),
  };
}

/**
 * The advisor's open and capacity as the card would show them at `atMs`: the starts still
 * bookable then, packed, and stopped at what a daily cap leaves, as `advisorDay` does.
 */
export function walkAdvisorAt(a: WalkAdvisor, eventType: CapacityEventType, atMs: number): { open: number; capacity: number } {
  const cutoff = atMs + eventType.min_notice_min * 60_000;
  const packed = (starts: string[], already: number) => {
    const fit = callsThatFit(starts.filter((s) => Date.parse(s) >= cutoff), eventType).length;
    return eventType.daily_cap === null ? fit : Math.min(fit, Math.max(0, eventType.daily_cap - already));
  };
  return { open: packed(a.openStarts, a.bookedOnDay), capacity: packed(a.capacityStarts, 0) };
}

/** One row of the pattern table: average taken per half hour reading, and how many readings. */
export interface PatternCell {
  /** The day's index among the booker's days. */
  dayPosition: number;
  /** The half hour of the office's day, 0 to 47. */
  slotOfDay: number;
  /** Luxon's weekday (1 = Monday) for a weekday's own cell; null for all days together. */
  weekday: number | null;
  avgTaken: number;
  samples: number;
}

/** The cell a reading at an instant is stamped with: the lane's own `officeSlot` and day position. */
export interface CellKey {
  /** Null when the booker does not offer the day at that instant: no cell. */
  dayPosition: number | null;
  slotOfDay: number;
  weekday: number;
}

export interface EstimateInput {
  readAtMs: number;
  /** Every advisor on the page for the day, counted or not, as `dayTotals` takes them. */
  advisors: WalkAdvisor[];
  eventType: CapacityEventType;
  pace: Pace;
  pattern: PatternCell[];
  /**
   * The cell a reading at this instant would be stamped with. Injected so the zone arithmetic
   * stays in the one helper that stamps the readings.
   */
  cellAt: (stepMs: number) => CellKey;
}

export type Estimate =
  /** 95% or more now: the percent already says it, so no time. */
  | { state: "already" }
  | { state: "at"; atMs: number }
  /** The walk reached the day's last bookable moment under 95%. */
  | { state: "wont-fill" }
  /** No pace to walk with: the straight line always, the pattern when a cell needed it. */
  | { state: "no-pace-yet" }
  /** Nobody counted has a call on the day, so there is no percent to reach. */
  | { state: "no-capacity" };

export interface FillEstimates {
  line: Estimate;
  pattern: Estimate;
  /** The method the card shows: the pattern only when no cell it used fell back. */
  shown: "line" | "pattern";
  /** Distinct cells the pattern walk used that fell back to the straight line. */
  cellsFallenBack: number;
}

/** Whether the team's day is at FULL_BY_PCT or more with `taken` expected to come off its open. */
function reached(team: { open: number; capacity: number }, taken: number): boolean {
  const open = Math.max(0, team.open - Math.max(0, taken));
  const pct = dayTotals([{ unsynced: false, days: [{ open, capacity: team.capacity, out: false }] }], 0).fullPct;
  return pct !== null && pct >= FULL_BY_PCT;
}

/** Both estimates for one day at the reading. */
export function estimate(input: EstimateInput): FillEstimates {
  const { readAtMs, eventType } = input;
  const counted = input.advisors.filter((a) => !a.unsynced && !a.out);

  // The day's last bookable moment: its latest start less the notice.
  let lastStartMs = -Infinity;
  for (const a of counted) for (const s of a.capacityStarts) lastStartMs = Math.max(lastStartMs, Date.parse(s));
  const lastMs = lastStartMs - eventType.min_notice_min * 60_000;

  // The team's open and capacity at each step, shared by both walks.
  const steps: { atMs: number; open: number; capacity: number }[] = [];
  for (let t = readAtMs; t <= lastMs; t += WALK_STEP_MS) {
    const days = input.advisors.map((a) => ({ unsynced: a.unsynced, days: [{ out: a.out, ...walkAdvisorAt(a, eventType, t) }] }));
    const totals = dayTotals(days, 0);
    steps.push({ atMs: t, open: totals.open, capacity: totals.capacity });
  }
  if (steps.length === 0 || steps[0].capacity === 0) {
    return { line: { state: "no-capacity" }, pattern: { state: "no-capacity" }, shown: "line", cellsFallenBack: 0 };
  }
  if (reached(steps[0], 0)) return { line: { state: "already" }, pattern: { state: "already" }, shown: "line", cellsFallenBack: 0 };

  const linePerStep = input.pace.state === "no-pace-yet" ? null : (input.pace.perHour * WALK_STEP_MS) / 3_600_000;
  const walk = (expectedAt: (stepMs: number) => number | null): Estimate => {
    let taken = 0;
    for (let k = 1; k < steps.length; k++) {
      // A reading stamps the half hour that ENDS at it, so the taken up to a step is its cell's.
      const expected = expectedAt(steps[k].atMs);
      if (expected === null) return { state: "no-pace-yet" };
      taken += expected;
      if (reached(steps[k], taken)) return { state: "at", atMs: steps[k].atMs };
    }
    return { state: "wont-fill" };
  };

  const cells = new Map(input.pattern.map((c) => [`${c.dayPosition}|${c.slotOfDay}|${c.weekday ?? "*"}`, c]));
  const fellBack = new Set<string>();
  let used = 0;
  const pattern = walk((stepMs) => {
    const key = input.cellAt(stepMs);
    used++;
    if (key.dayPosition !== null) {
      const own = cells.get(`${key.dayPosition}|${key.slotOfDay}|${key.weekday}`);
      if (own && own.samples >= PATTERN_WEEKDAY_MIN_SAMPLES) return own.avgTaken;
      const all = cells.get(`${key.dayPosition}|${key.slotOfDay}|*`);
      if (all && all.samples >= PATTERN_MIN_SAMPLES) return all.avgTaken;
    }
    fellBack.add(`${key.dayPosition}|${key.slotOfDay}|${key.weekday}`);
    return linePerStep;
  });

  return {
    line: linePerStep === null ? { state: "no-pace-yet" } : walk(() => linePerStep),
    pattern,
    shown: used > 0 && fellBack.size === 0 ? "pattern" : "line",
    cellsFallenBack: fellBack.size,
  };
}

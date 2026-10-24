/**
 * Booking pace on Team capacity (#4103): how fast each page day is filling, and when it will reach
 * 95% full, worked out from the half hour readings (#4102) by two methods from day one.
 *
 * ## Pace
 *
 * Net calls taken over the KNOWN intervals of the last 3 hours, per hour. Each reading's taken is
 * already scaled to the counted team. An interval counts for the time it ran, so a reading after a
 * gap counts its hour and a half; one that began before the window is left out whole rather than
 * shared out by a guess. There is no pace yet under 3 hours of readings in all (launch, or the
 * night a new day joins the cards). After that, under 2 known hours of the last 3 means readings
 * were missed, said with the half hour the pace comes back if readings resume (Dan, 2026-10-22,
 * #4101). At or under 0 the day is not filling, a state of its own.
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
 * ## The last call
 *
 * From 95% the card's Full by is when no call is left open (Dan, 2026-10-23, #4190, decision 20):
 * the same walk, judged by the open count reaching 0 rather than by the percent, because the
 * percent rounds and would call a day with one call left 100%.
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
  /** Under 3 hours of readings in all: launch, or a new day joining the cards. */
  | { state: "no-pace-yet"; knownHours: number }
  /**
   * Readings go back 3 hours, but under 2 of the last 3 are known. `backAtMs` is the earliest
   * half hour at which 2 would be, if a known reading arrives every half hour from now.
   */
  | { state: "readings-missed"; knownHours: number; backAtMs: number };

/** An instant read from a stored or computed string; one that does not parse throws (L50). */
function instantMs(iso: string, what: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`${what} is not a readable instant: "${iso}"`);
  return ms;
}

/** Known time, and the calls taken in it, over the readings measured inside [fromMs, toMs]. */
function knownWithin(readings: { fromMs: number | null; toMs: number; taken: number | null }[], fromMs: number, toMs: number): { knownMs: number; taken: number } {
  let knownMs = 0, taken = 0;
  for (const r of readings) {
    // A reading that began before the window is left out whole, never shared out by a guess.
    if (r.taken === null || r.fromMs === null || r.fromMs < fromMs || r.toMs > toMs) continue;
    knownMs += r.toMs - r.fromMs;
    taken += r.taken;
  }
  return { knownMs, taken };
}

/**
 * One day's pace at `nowMs`, from that day's readings. Pass every reading of the day back to at
 * least 3 hours before `nowMs`: the earliest one is what says whether 3 hours of readings exist.
 */
export function pace(readings: PaceReading[], nowMs: number): Pace {
  const parsed = readings.map((r) => ({
    fromMs: r.prev_read_at === null ? null : instantMs(r.prev_read_at, "a capacity fill reading's prev_read_at"),
    toMs: instantMs(r.read_at, "a capacity fill reading's read_at"),
    taken: r.taken,
  }));
  // The earliest instant the day was read at: a reading's own, or the one it was compared with.
  let earliestMs = Infinity;
  for (const r of parsed) if (r.toMs <= nowMs) earliestMs = Math.min(earliestMs, r.fromMs ?? r.toMs);

  const { knownMs, taken } = knownWithin(parsed, nowMs - PACE_WINDOW_MS, nowMs);
  const knownHours = knownMs / 3_600_000;
  if (earliestMs > nowMs - PACE_WINDOW_MS) return { state: "no-pace-yet", knownHours };
  if (knownMs < PACE_MIN_KNOWN_MS) {
    // Each later half hour adds a known reading while the oldest known ones age out of the window.
    // Four readings make 2 hours on their own, so the answer is never later than that.
    for (let j = 1; j * WALK_STEP_MS <= PACE_MIN_KNOWN_MS; j++) {
      const atMs = nowMs + j * WALK_STEP_MS;
      if (knownWithin(parsed, atMs - PACE_WINDOW_MS, nowMs).knownMs + j * WALK_STEP_MS >= PACE_MIN_KNOWN_MS) {
        return { state: "readings-missed", knownHours, backAtMs: atMs };
      }
    }
    throw new Error("four half hourly readings must make 2 known hours");
  }
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
    const fit = callsThatFit(starts.filter((s) => instantMs(s, "an advisor's start") >= cutoff), eventType).length;
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
  /** What the walk reaches: 95% full (the default), or no call left open (#4190). */
  target?: EstimateTarget;
}

export type EstimateTarget = "full-by" | "last-call";

export type Estimate =
  /** At the target now (95% or more, or no call open): the card already says it, so no time. */
  | { state: "already" }
  | { state: "at"; atMs: number }
  /** The walk reached the day's last bookable moment short of the target. */
  | { state: "wont-fill" }
  /** No pace to walk with (not yet, or readings missed: the pace says which): the straight
   *  line always, the pattern when a cell needed it. */
  | { state: "no-pace" }
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

/** Whether the team's day reaches the target with `taken` expected to come off its open. */
function reached(team: { open: number; capacity: number }, taken: number, target: EstimateTarget): boolean {
  const open = Math.max(0, team.open - Math.max(0, taken));
  if (target === "last-call") return open === 0;
  const pct = dayTotals([{ unsynced: false, days: [{ open, capacity: team.capacity, out: false }] }], 0).fullPct;
  return pct !== null && pct >= FULL_BY_PCT;
}

/** Both estimates for one day at the reading. */
export function estimate(input: EstimateInput): FillEstimates {
  const { readAtMs, eventType } = input;
  const target = input.target ?? "full-by";
  const counted = input.advisors.filter((a) => !a.unsynced && !a.out);

  // The day's last bookable moment: its latest start less the notice.
  let lastStartMs = -Infinity;
  for (const a of counted) for (const s of a.capacityStarts) lastStartMs = Math.max(lastStartMs, instantMs(s, "an advisor's start"));
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
  if (reached(steps[0], 0, target)) return { line: { state: "already" }, pattern: { state: "already" }, shown: "line", cellsFallenBack: 0 };

  const p = input.pace;
  const linePerStep = p.state === "pace" || p.state === "not-filling" ? (p.perHour * WALK_STEP_MS) / 3_600_000 : null;
  const walk = (expectedAt: (stepMs: number) => number | null): Estimate => {
    let taken = 0;
    for (let k = 1; k < steps.length; k++) {
      // A reading stamps the half hour that ENDS at it, so the taken up to a step is its cell's.
      const expected = expectedAt(steps[k].atMs);
      if (expected === null) return { state: "no-pace" };
      taken += expected;
      if (reached(steps[k], taken, target)) return { state: "at", atMs: steps[k].atMs };
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
    line: linePerStep === null ? { state: "no-pace" } : walk(() => linePerStep),
    pattern,
    shown: used > 0 && fellBack.size === 0 ? "pattern" : "line",
    cellsFallenBack: fellBack.size,
  };
}

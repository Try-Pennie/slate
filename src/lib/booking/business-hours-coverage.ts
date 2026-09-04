/**
 * The coverage readout inside the business-hours editor (#1297): for each hour the
 * org is open, how many bookable agents are actually rostered to take a booking.
 *
 * Pure (luxon only, no `@/` imports) so `scripts/test-business-hours-coverage.ts`
 * drives it node-native.
 *
 * ## Three honest states, because two of them look alike
 *
 * A count, a real zero, and "could not check". `loadAllWorkingHours` THROWS on a read
 * error rather than returning empty, and that distinction has to survive all the way
 * to the screen: an unreadable roster rendered as "nobody covers this" reads as a
 * staffing problem, and someone would go and fix a roster that was fine. So `agents:
 * null` produces `{ ok: false }` carrying no counts at all, rather than zeroes.
 *
 * ## Each zone is its own
 *
 * The org's hours are in the org's clock and an agent's are in theirs, exactly as the
 * three gates judge them, and the two are never intersected as raw minute numbers.
 * An agent in Los Angeles working 06:00 to 09:00 covers the org's 09:00 to 12:00
 * Eastern; a minute comparison would place them at 06:00 to 09:00 Eastern and invent
 * a staffing gap that does not exist. Every live agent is Eastern, so nothing in
 * production could tell the two implementations apart.
 *
 * Coverage is evaluated against a CONCRETE date (the given week's occurrence of each
 * weekday) rather than notionally, so a real zone offset applies and a DST week is
 * judged on that week's actual offsets.
 */
import { DateTime } from "luxon";

export interface CoverageRule {
  weekday: number;
  start_minute: number;
  end_minute: number;
}

/** One bookable agent: their own zone and their own weekly rules. */
export interface CoverageAgent {
  timezone: string;
  rules: CoverageRule[];
  /**
   * Approved time off, as absolute intervals (#1582). Half-open, matching the
   * overlap convention coverage reassignment reads (#1236): leave that merely
   * abuts an hour does not discount it. Optional because only the availability
   * grid loads leave today; a caller that does not pass it is judged exactly as
   * before, never as if everyone were present when nobody checked.
   */
  out?: { startMs: number; endMs: number }[];
}

export interface CoverageHour {
  /** Hour of the day in the ORG's zone. */
  hour: number;
  /** How many bookable agents are on shift for that whole hour AND not away. */
  agents: number;
  /** How many of the rostered are on approved time off overlapping this hour.
   *  Its own number, never a silent decrement: "everybody scheduled is away"
   *  and "nobody was ever scheduled" are different facts for different people. */
  away: number;
}

export interface CoverageDay {
  weekday: number;
  is_open: boolean;
  /** Empty for a closed day, so it can never be read as a coverage gap. */
  hours: CoverageHour[];
}

export type CoverageReadout =
  | { ok: false }
  | {
      ok: true;
      /** Agents who can actually take a booking: active AND bookable. Counting the
       *  flag alone overstated the pool by 11 leavers in production (2026-08-06). */
      bookableAgents: number;
      days: CoverageDay[];
      /** Open hours across the week with nobody rostered. */
      uncoveredHours: number;
    };

/** Whether `agent` is on shift for the whole of [startMs, endMs), judged in THEIR zone. */
/**
 * The two date questions the shift test asks, behind a seam so they can be
 * memoised without changing what they answer (#1864).
 *
 * Both are pure functions of a zone and an instant, and both are expensive:
 * building a zone-aware date is the single costliest thing this walk does.
 */
export interface CoverageClock {
  /** Start of the local day containing `atMs` in `zone`, and its weekday. */
  day(zone: string, atMs: number): { startMs: number; weekday: number };
  /** The ms bounds of [startMinute, endMinute) on the local day starting at `dayStartMs`. */
  window(
    zone: string,
    dayStartMs: number,
    startMinute: number,
    endMinute: number,
  ): { startMs: number; endMs: number };
}

/** Ask Luxon every time. The behaviour every caller had before the memo existed. */
export const realCoverageClock: CoverageClock = {
  day(zone, atMs) {
    const d = DateTime.fromMillis(atMs, { zone }).startOf("day");
    return { startMs: d.toMillis(), weekday: d.weekday };
  },
  window(zone, dayStartMs, startMinute, endMinute) {
    const day = DateTime.fromMillis(dayStartMs, { zone });
    return {
      startMs: day.plus({ minutes: startMinute }).toMillis(),
      // A rule running to midnight is the NEXT day's start, not 1440 minutes on,
      // which differs by an hour across a clock change.
      endMs:
        endMinute >= 1440
          ? day.plus({ days: 1 }).startOf("day").toMillis()
          : day.plus({ minutes: endMinute }).toMillis(),
    };
  },
};

/**
 * The same clock, asked at most once per distinct question (#1864).
 *
 * The availability grid asks whether each of ~100 agents is on shift for each of
 * ~12 hours on each of 14 days, which is over 17,000 shift tests, and each one
 * built a zone-aware date from scratch. Measured on the live roster: that walk
 * took 342ms locally, which is most of the Worker CPU the page still spent after
 * #1846.
 *
 * Nearly all of it repeats. There are five distinct timezones across the roster,
 * so for a given instant every agent in a zone resolves the identical local day,
 * and agents sharing a shift pattern resolve identical window bounds.
 *
 * KEYED ON THE ZONE AND THE INSTANT, NEVER ON THE AGENT OR THE ORG'S DATE. Which
 * of an agent's rules apply is decided by THEIR local weekday, and the roster
 * spans seven zones, so one org day can fall on two different local weekdays for
 * the same agent. Keying on anything coarser collapses that boundary and puts
 * somebody on shift on the wrong day; the guard drives exactly those cases,
 * including the weeks when only one of two zones has changed its clocks.
 *
 * IT MUST NOT OUTLIVE THE WALK. A caller builds one and discards it, because the
 * roster it is computed against is read per request; a module level cache here
 * would serve a stale roster for as long as the isolate lived.
 */
export function memoisedCoverageClock(inner: CoverageClock = realCoverageClock): CoverageClock {
  const days = new Map<string, { startMs: number; weekday: number }>();
  const windows = new Map<string, { startMs: number; endMs: number }>();
  return {
    day(zone, atMs) {
      const key = `${zone}|${atMs}`;
      let hit = days.get(key);
      if (hit === undefined) {
        hit = inner.day(zone, atMs);
        days.set(key, hit);
      }
      return hit;
    },
    window(zone, dayStartMs, startMinute, endMinute) {
      const key = `${zone}|${dayStartMs}|${startMinute}|${endMinute}`;
      let hit = windows.get(key);
      if (hit === undefined) {
        hit = inner.window(zone, dayStartMs, startMinute, endMinute);
        windows.set(key, hit);
      }
      return hit;
    },
  };
}

function coversInterval(
  agent: CoverageAgent,
  startMs: number,
  endMs: number,
  clock: CoverageClock,
): boolean {
  const day = clock.day(agent.timezone, startMs);
  for (const rule of agent.rules) {
    if (rule.weekday !== day.weekday) continue;
    const win = clock.window(agent.timezone, day.startMs, rule.start_minute, rule.end_minute);
    if (startMs >= win.startMs && endMs <= win.endMs) return true;
  }
  return false;
}

/**
 * Coverage for ONE concrete date under ONE window (#1581).
 *
 * The per-date half of `coverageForWeek`, extracted so a caller that resolves
 * its window per DATE (the availability grid, whose dates can carry a #1363
 * exception) judges each hour through the same predicate as the callers that
 * resolve it per weekday. A second walk beside this one would be a second
 * definition of "who is on shift", agreeing right up until the two drifted
 * (L107). A `null` window is a closed day, whose `hours` stay empty so it can
 * never be read as a coverage gap.
 */
export function coverageForDate(input: {
  window: { start_minute: number; end_minute: number } | null;
  /** The ORG's zone. */
  zone: string;
  /** yyyy-mm-dd of the date being judged, in the org's zone. */
  dateIso: string;
  agents: CoverageAgent[];
  /**
   * Who answers the date questions. Defaults to asking Luxon every time, which
   * is what a caller judging one date wants; a caller walking MANY dates against
   * one roster passes a `memoisedCoverageClock` so the repeats cost nothing
   * (#1864).
   */
  clock?: CoverageClock;
}): CoverageDay {
  const clock = input.clock ?? realCoverageClock;
  const date = DateTime.fromISO(input.dateIso, { zone: input.zone }).startOf("day");
  if (input.window === null) return { weekday: date.weekday, is_open: false, hours: [] };

  const hours: CoverageHour[] = [];
  // Whole hours only: a readout is for reading, and the org's window is set in
  // minutes but nobody staffs to the quarter hour.
  const firstHour = Math.floor(input.window.start_minute / 60);
  const lastHour = Math.ceil(input.window.end_minute / 60) - 1;
  for (let hour = firstHour; hour <= lastHour; hour++) {
    const startMs = date.set({ hour, minute: 0, second: 0, millisecond: 0 }).toMillis();
    const endMs = date.set({ hour, minute: 0, second: 0, millisecond: 0 })
      .plus({ hours: 1 })
      .toMillis();
    // Rostered first, then partitioned by leave: an agent never on shift for the
    // hour is unrostered there, not away, or a day off would double-report.
    const rostered = input.agents.filter((a) => coversInterval(a, startMs, endMs, clock));
    const away = rostered.filter((a) =>
      (a.out ?? []).some((o) => o.startMs < endMs && o.endMs > startMs),
    ).length;
    hours.push({ hour, agents: rostered.length - away, away });
  }
  return { weekday: date.weekday, is_open: true, hours };
}

export function coverageForWeek(input: {
  businessHours: { weekday: number; is_open: boolean; start_minute: number; end_minute: number }[];
  /** The ORG's zone. */
  zone: string;
  /** Bookable agents, or `null` when the roster could not be read. */
  agents: CoverageAgent[] | null;
  /** ISO date (yyyy-mm-dd) of the Monday whose week is being evaluated. */
  weekStartIso: string;
}): CoverageReadout {
  if (input.agents === null) return { ok: false };
  const agents = input.agents;

  const monday = DateTime.fromISO(input.weekStartIso, { zone: input.zone }).startOf("day");
  const days: CoverageDay[] = [];
  let uncoveredHours = 0;

  for (const bh of [...input.businessHours].sort((a, b) => a.weekday - b.weekday)) {
    const day = coverageForDate({
      window: bh.is_open ? { start_minute: bh.start_minute, end_minute: bh.end_minute } : null,
      zone: input.zone,
      dateIso: monday.plus({ days: bh.weekday - 1 }).toISODate() ?? "",
      agents,
    });
    for (const h of day.hours) if (h.agents === 0) uncoveredHours++;
    days.push({ ...day, weekday: bh.weekday });
  }

  return { ok: true, bookableAgents: agents.length, days, uncoveredHours };
}

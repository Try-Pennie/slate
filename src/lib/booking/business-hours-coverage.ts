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
}

export interface CoverageHour {
  /** Hour of the day in the ORG's zone. */
  hour: number;
  /** How many bookable agents are on shift for that whole hour. */
  agents: number;
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
function coversInterval(agent: CoverageAgent, startMs: number, endMs: number): boolean {
  const day = DateTime.fromMillis(startMs, { zone: agent.timezone }).startOf("day");
  for (const rule of agent.rules) {
    if (rule.weekday !== day.weekday) continue;
    const winStart = day.set({ hour: 0, minute: 0, second: 0, millisecond: 0 })
      .plus({ minutes: rule.start_minute })
      .toMillis();
    const winEnd =
      rule.end_minute >= 1440
        ? day.plus({ days: 1 }).startOf("day").toMillis()
        : day.set({ hour: 0, minute: 0, second: 0, millisecond: 0 })
            .plus({ minutes: rule.end_minute })
            .toMillis();
    if (startMs >= winStart && endMs <= winEnd) return true;
  }
  return false;
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
    if (!bh.is_open) {
      days.push({ weekday: bh.weekday, is_open: false, hours: [] });
      continue;
    }
    const date = monday.plus({ days: bh.weekday - 1 });
    const hours: CoverageHour[] = [];
    // Whole hours only: a readout is for reading, and the org's window is set in
    // minutes but nobody staffs to the quarter hour.
    const firstHour = Math.floor(bh.start_minute / 60);
    const lastHour = Math.ceil(bh.end_minute / 60) - 1;
    for (let hour = firstHour; hour <= lastHour; hour++) {
      const startMs = date.set({ hour, minute: 0, second: 0, millisecond: 0 }).toMillis();
      const endMs = date.set({ hour, minute: 0, second: 0, millisecond: 0 })
        .plus({ hours: 1 })
        .toMillis();
      const count = agents.filter((a) => coversInterval(a, startMs, endMs)).length;
      if (count === 0) uncoveredHours++;
      hours.push({ hour, agents: count });
    }
    days.push({ weekday: bh.weekday, is_open: true, hours });
  }

  return { ok: true, bookableAgents: agents.length, days, uncoveredHours };
}

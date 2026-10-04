// Pure seed generator for the load test. Produces in-memory rows that mirror
// production's shape so the recompute, sync and BOOKING paths do realistic work
// against a seeded (isolated) DB. No DB/network here: seed.ts inserts what this
// returns. Deterministic (index derived, no randomness) so a load run is
// repeatable. Exercised by scripts/test-loadtest-generate.ts.
//
// Two things changed for the booking path run (#2243), and both were measured
// against production on 2026-09-11 rather than assumed:
//
//   the attribute distribution comes from `roster-shape.ts` instead of weights
//   measured in June, which had the Beyond backend at 60 percent of the roster
//   where production has two agents in it. That difference is the burst's control:
//   every `x2x` bucket resolves to a pool of exactly ONE agent;
//
//   busy blocks are placed in each agent's OWN LOCAL working day rather than at a
//   fixed offset from the seed instant. The roster spans five zones, so a UTC
//   anchored block lands mid morning for one agent and after hours for another,
//   and an agent whose blocks all fall outside their own hours is simply free all
//   day: the seed would understate contention exactly where the booking path is
//   meant to meet it.
import { SEED_AGENT_EMAIL_DOMAIN } from "./seed-guards.ts";
import { DateTime } from "luxon";
import { PRODUCTION_SHAPE, scaleShape, zoneForIndex, type RosterShape } from "./roster-shape.ts";
export interface SeedParams {
  agentCount: number;
  orgId: string;
  /** Window start (ms); busy_blocks fall in [nowMs, nowMs + windowDays). */
  nowMs: number;
  /** Recompute horizon in days (HORIZON_DAYS = 4 in prod). */
  windowDays: number;
  /** In-window busy_blocks per agent per day (realistic meeting density). */
  blocksPerAgentPerDay: number;
  calendarsPerAgent?: number;
  /** The roster to reproduce. Defaults to production as measured 2026-09-11. */
  shape?: RosterShape;
}

export interface SeedUser {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: string;
  attributes: Record<string, string | string[]>;
  bookable: boolean;
  deactivated_at: string | null;
}
export interface SeedSchedule {
  id: string;
  user_id: string;
  timezone: string;
}
export interface SeedRule {
  schedule_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
}
export interface SeedCalendar {
  user_id: string;
  calendar_id: string;
}
export interface SeedBusyBlock {
  user_id: string;
  starts_at: string;
  ends_at: string;
  source: "gcal" | "slate";
  calendar_id: string;
}
export interface GeneratedSeed {
  users: SeedUser[];
  schedules: SeedSchedule[];
  rules: SeedRule[];
  agentCalendars: SeedCalendar[];
  busyBlocks: SeedBusyBlock[];
}

const hex12 = (n: number) => n.toString(16).padStart(12, "0");
// Deterministic, valid 8-4-4-4-12 hex UUIDs, namespaced by row kind.
const uuid = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${hex12(n)}`;

/**
 * The working day every seeded agent keeps, in their OWN zone: Monday to Friday,
 * 09:00 to 17:00 local, which is Slate's seeded default.
 */
const WORK_START_MIN = 540;
const WORK_END_MIN = 1020;

/**
 * One agent's profile per index, INTERLEAVED across the profiles rather than
 * blocked.
 *
 * Blocked would put every Low-only agent first and both Beyond agents last, so any
 * run that seeded a prefix of the roster would have no Beyond agent at all and the
 * burst's one agent pool would be a pool of nobody. Interleaving costs nothing and
 * makes every prefix representative.
 */
function profileForIndex(profiles: { agents: number }[], index: number): number {
  const total = profiles.reduce((s, p) => s + p.agents, 0);
  if (total === 0) return 0;
  const order: number[] = [];
  const remaining = profiles.map((p) => p.agents);
  while (remaining.some((n) => n > 0)) {
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i]! > 0) {
        order.push(i);
        remaining[i]!--;
      }
    }
  }
  return order[index % order.length]!;
}

export function generateSeed(p: SeedParams): GeneratedSeed {
  const calsPerAgent = p.calendarsPerAgent ?? 1;
  // One calendar per agent, named by the agent's EMAIL, because that is the only
  // calendar the Google stub's list returns and the id it gives it (#2380, as real
  // Google does). Anything else is deleted by the watch lane's reconcile on its
  // first tick, with the busy blocks seeded under it, which is what stalled run
  // 37164364760's warm up (#3103). scripts/test-loadtest-generate.ts ties the two.
  if (calsPerAgent !== 1) {
    throw new Error(
      `calendarsPerAgent is ${calsPerAgent}, and the Google stub lists exactly one calendar per agent: ` +
        "any other seeded calendar is reconciled away (with its busy blocks) on the first watch tick. " +
        "Leave CALS_PER_AGENT unset.",
    );
  }
  const shape = p.shape ?? PRODUCTION_SHAPE;
  const users: SeedUser[] = [];
  const schedules: SeedSchedule[] = [];
  const rules: SeedRule[] = [];
  const agentCalendars: SeedCalendar[] = [];
  const busyBlocks: SeedBusyBlock[] = [];

  // Attributes by the MEASURED production shape, so per bucket pool sizes match
  // reality rather than an even spread. The pool sizes are what drive recompute
  // cost, and the smallest of them is what the burst's control rests on.
  const profiles = scaleShape(shape, p.agentCount);

  for (let i = 0; i < p.agentCount; i++) {
    const userId = uuid("a", i);
    const scheduleId = uuid("b", i);
    const profile = profiles[profileForIndex(profiles, i)]!;
    const timezone = zoneForIndex(shape, i, p.agentCount);
    const attrs: Record<string, string | string[]> = {};
    if (profile.debtTeam.length > 0) attrs.debt_team = [...profile.debtTeam];
    if (profile.backendService.length > 0) attrs.backend_service = [...profile.backendService];

    // The domain is the seed's marker, which the between arms reset checks (#3258).
    const email = `loadtest-agent-${i}@${SEED_AGENT_EMAIL_DOMAIN}`;
    users.push({
      id: userId,
      org_id: p.orgId,
      email,
      name: `Loadtest Agent ${i}`,
      role: "agent",
      attributes: attrs,
      bookable: true,
      deactivated_at: null,
    });
    schedules.push({ id: scheduleId, user_id: userId, timezone });
    // Mon-Fri 9:00-17:00 LOCAL (minutes 540-1020), like the default working hours.
    for (let weekday = 1; weekday <= 5; weekday++) {
      rules.push({
        schedule_id: scheduleId,
        weekday,
        start_minute: WORK_START_MIN,
        end_minute: WORK_END_MIN,
      });
    }
    // The stub's primary calendar id IS the agent's address (see above).
    const calendarId = email;
    agentCalendars.push({ user_id: userId, calendar_id: calendarId });

    // Busy blocks inside the agent's OWN LOCAL working day, every day of the
    // horizon. Day ALIGNED rather than offset from the seed instant: the roster
    // spans five zones, so a fixed UTC offset lands mid morning for an Eastern
    // agent and after hours for a Pacific one, and an agent whose blocks all fall
    // outside their own hours reads as free all day. The seed would then
    // understate contention in exactly the zones the booking run is meant to press.
    const startOfDay = DateTime.fromMillis(p.nowMs, { zone: timezone }).startOf("day");
    for (let d = 0; d < p.windowDays; d++) {
      const day = startOfDay.plus({ days: d });
      // A weekend day has no working hours, so a block there would be busy time
      // nothing could have booked over anyway. Skipped, which also means the block
      // count varies with where the window falls, exactly as a real calendar does.
      if (day.weekday > 5) continue;
      for (let k = 0; k < p.blocksPerAgentPerDay; k++) {
        const offsetMin =
          WORK_START_MIN +
          Math.floor((k * (WORK_END_MIN - WORK_START_MIN)) / p.blocksPerAgentPerDay);
        const start = day.plus({ minutes: offsetMin });
        busyBlocks.push({
          user_id: userId,
          starts_at: start.toUTC().toISO()!,
          ends_at: start.plus({ minutes: 30 }).toUTC().toISO()!,
          source: (i + d + k) % 5 === 0 ? "slate" : "gcal",
          calendar_id: calendarId,
        });
      }
    }
  }

  return { users, schedules, rules, agentCalendars, busyBlocks };
}

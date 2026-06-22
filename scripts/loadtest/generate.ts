// Pure seed generator for the 200-agent load test (#273 Increment 5). Produces
// in-memory rows that mirror production's shape so the recompute + sync lanes do
// realistic work against a seeded (isolated) DB. No DB/network here — seed.ts
// inserts what this returns. Deterministic (index-derived, no randomness) so a
// load run is repeatable. Exercised by scripts/test-loadtest-generate.ts.
import { allXbcCodes, bucketSpecForXbc } from "../../src/lib/xbc.ts";

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
}

export interface SeedUser {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: string;
  attributes: Record<string, string>;
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

const DAY_MS = 86_400_000;
const hex12 = (n: number) => n.toString(16).padStart(12, "0");
// Deterministic, valid 8-4-4-4-12 hex UUIDs, namespaced by row kind.
const uuid = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${hex12(n)}`;

/**
 * Invert a bucket's criteria into agent attributes that SATISFY it, so the agent
 * lands in that bucket (and others it overlaps). Positive keys copy through; a
 * negated key (e.g. `legal_eligible!: "N"`) is satisfied by setting a different
 * value, so the agent passes the "does not equal" filter.
 */
function attributesForCode(code: string): Record<string, string> {
  const spec = bucketSpecForXbc(code);
  const criteria = spec?.criteria ?? {};
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(criteria)) {
    if (key.endsWith("!")) {
      // negated: set the real attribute to something other than the excluded value
      attrs[key.slice(0, -1)] = value === "N" ? "Y" : "N";
    } else {
      attrs[key] = String(value);
    }
  }
  return attrs;
}

export function generateSeed(p: SeedParams): GeneratedSeed {
  const codes = allXbcCodes();
  const calsPerAgent = p.calendarsPerAgent ?? 1;
  const users: SeedUser[] = [];
  const schedules: SeedSchedule[] = [];
  const rules: SeedRule[] = [];
  const agentCalendars: SeedCalendar[] = [];
  const busyBlocks: SeedBusyBlock[] = [];

  for (let i = 0; i < p.agentCount; i++) {
    const userId = uuid("a", i);
    const scheduleId = uuid("b", i);
    // Spread agents across the XBC attribute space so all 60 buckets get a pool.
    const attrs = attributesForCode(codes[i % codes.length]);

    users.push({
      id: userId,
      org_id: p.orgId,
      email: `loadtest-agent-${i}@loadtest.local`,
      name: `Loadtest Agent ${i}`,
      role: "agent",
      attributes: attrs,
      bookable: true,
      deactivated_at: null,
    });
    schedules.push({ id: scheduleId, user_id: userId, timezone: "America/New_York" });
    // Mon-Fri 9:00-17:00 (minutes 540-1020), like the default working hours.
    for (let weekday = 1; weekday <= 5; weekday++) {
      rules.push({ schedule_id: scheduleId, weekday, start_minute: 540, end_minute: 1020 });
    }
    for (let c = 0; c < calsPerAgent; c++) {
      agentCalendars.push({ user_id: userId, calendar_id: c === 0 ? "primary" : `cal-${c}` });
    }

    // In-window busy blocks: blocksPerAgentPerDay across the workday, every day
    // of the horizon. 1-in-5 marked 'slate' (booking write-through), rest 'gcal'.
    for (let d = 0; d < p.windowDays; d++) {
      for (let k = 0; k < p.blocksPerAgentPerDay; k++) {
        // spread k blocks across an 8h workday starting 09:00 UTC
        const offsetMin = 9 * 60 + Math.floor((k * 8 * 60) / p.blocksPerAgentPerDay);
        const startMs = p.nowMs + d * DAY_MS + offsetMin * 60_000;
        busyBlocks.push({
          user_id: userId,
          starts_at: new Date(startMs).toISOString(),
          ends_at: new Date(startMs + 30 * 60_000).toISOString(),
          source: (i + d + k) % 5 === 0 ? "slate" : "gcal",
          calendar_id: "primary",
        });
      }
    }
  }

  return { users, schedules, rules, agentCalendars, busyBlocks };
}

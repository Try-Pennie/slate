// Pure seed generator for the 200-agent load test (#273 Increment 5). Produces
// in-memory rows that mirror production's shape so the recompute + sync lanes do
// realistic work against a seeded (isolated) DB. No DB/network here — seed.ts
// inserts what this returns. Deterministic (index-derived, no randomness) so a
// load run is repeatable. Exercised by scripts/test-loadtest-generate.ts.
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

const DAY_MS = 86_400_000;
const hex12 = (n: number) => n.toString(16).padStart(12, "0");
// Deterministic, valid 8-4-4-4-12 hex UUIDs, namespaced by row kind.
const uuid = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${hex12(n)}`;

// Production attribute distribution (bookable+active, ~111 agents, measured
// 2026-06-22 for #273 load-test calibration). debt_team is CUMULATIVE — an agent
// on a tier also carries the tiers below — which is what makes the low-tier
// buckets pull large overlapping pools and concentrates recompute cost there. A
// single-tier-each seed would miss those hot buckets and understate the load.
const DEBT_PROFILES: { team: string[] | null; weight: number }[] = [
  { team: ["low"], weight: 33 },
  { team: ["medium", "low"], weight: 24 },
  { team: ["high", "medium", "low"], weight: 14 },
  { team: null, weight: 12 }, // unrouted: no debt_team (and no backend, below)
  { team: ["very_high", "high", "medium"], weight: 12 },
  { team: ["ultra_high", "very_high", "high", "medium"], weight: 8 },
  { team: ["high", "medium"], weight: 3 },
  { team: ["ultra_high", "very_high"], weight: 2 },
  { team: ["very_high", "high", "medium", "low"], weight: 1 },
  { team: ["very_high", "high"], weight: 1 },
  { team: ["ultra_high", "very_high", "high"], weight: 1 },
];
// backend_service among agents that HAVE a debt_team (the null-debt 12 also have
// no backend). legal_eligible is null for everyone in prod, so it's omitted.
const BACKEND_PROFILES: { svc: string[]; weight: number }[] = [
  { svc: ["beyond"], weight: 60 },
  { svc: ["achieve"], weight: 38 },
  { svc: ["beyond", "achieve"], weight: 1 },
];

/** Expand weighted profiles into exactly n deterministic index picks (proportional). */
function proportionalPicks(weights: number[], n: number): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  const picks: number[] = [];
  weights.forEach((w, idx) => {
    const count = Math.round((w / total) * n);
    for (let k = 0; k < count && picks.length < n; k++) picks.push(idx);
  });
  while (picks.length < n) picks.push(weights.length - 1); // pad rounding shortfall
  return picks.slice(0, n);
}

export function generateSeed(p: SeedParams): GeneratedSeed {
  const calsPerAgent = p.calendarsPerAgent ?? 1;
  const users: SeedUser[] = [];
  const schedules: SeedSchedule[] = [];
  const rules: SeedRule[] = [];
  const agentCalendars: SeedCalendar[] = [];
  const busyBlocks: SeedBusyBlock[] = [];

  // Assign attributes by the measured prod distribution so per-bucket pool sizes
  // (the recompute cost driver) match reality, not an even spread.
  const debtPicks = proportionalPicks(DEBT_PROFILES.map((d) => d.weight), p.agentCount);
  const backendPicks = proportionalPicks(BACKEND_PROFILES.map((b) => b.weight), p.agentCount);

  for (let i = 0; i < p.agentCount; i++) {
    const userId = uuid("a", i);
    const scheduleId = uuid("b", i);
    const team = DEBT_PROFILES[debtPicks[i]].team;
    const attrs: Record<string, string | string[]> = {};
    if (team) {
      attrs.debt_team = team;
      attrs.backend_service = BACKEND_PROFILES[backendPicks[i]].svc; // only routed agents have a backend
    }

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

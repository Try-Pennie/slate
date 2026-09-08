// A bookable agent on hours nobody set (#1753).
//
// A seeded default is indistinguishable from a deliberate choice. Every one of 117
// agents carried the same Monday to Friday 08:00 to 17:00 Eastern for months
// because nobody had edited it, and 81 of 100 turned out to keep different hours
// (#1738). Nothing could report it, because a stored week is a valid week whether
// or not it matches the one the agent keeps.
//
// `availability_schedules.hours_source` and `hours_set_at` (migration 0117) make
// "nobody has set this" a recorded fact: every writer names itself through the
// `replace_availability_rules` RPC, and the seeding path stamps `seed`. That only
// covers rows written after the stamp existed (L223). For the rows before it, the
// store's own evidence decides: a week still shaped exactly like the org default,
// zone included, was never touched; any other shape was set by somebody.
//
// It deliberately does not report an agent with no schedule row, or a row with no
// rules. That is `agents_without_schedule`'s finding (#838, #1670), and two checks
// naming the same person for the same fact is one alert too many.
import type { OrgDefaults } from "@/lib/schedule-core";

export const AGENTS_ON_UNSET_HOURS_KEY = "agents_on_unset_hours";

/** Who or what last wrote an agent's week. null = written before the stamp existed. */
export type HoursSource = "seed" | "agent" | "admin" | "calcom-import";
export const HOURS_SOURCES: readonly HoursSource[] = ["seed", "agent", "admin", "calcom-import"] as const;

export interface UnsetHoursAgent {
  id: string;
  email: string | null;
  name: string | null;
}

export interface UnsetHoursSchedule {
  user_id: string;
  timezone: string;
  hours_source: HoursSource | null;
  rules: { weekday: number; start_minute: number; end_minute: number }[];
}

export interface UnsetHoursInput {
  org: OrgDefaults;
  /** Bookable, live, non-test agents. */
  agents: UnsetHoursAgent[];
  schedules: UnsetHoursSchedule[];
}

/** A week as a comparable string: sorted days, minutes, and the zone. */
function weekKey(timezone: string, rules: UnsetHoursSchedule["rules"]): string {
  const days = [...rules]
    .map((r) => `${r.weekday}:${r.start_minute}-${r.end_minute}`)
    .sort()
    .join("|");
  return `${timezone}#${days}`;
}

/** The org default as the same comparable string. */
export function seedWeekKey(org: OrgDefaults): string {
  return weekKey(
    org.default_timezone,
    org.default_weekdays.map((weekday) => ({
      weekday,
      start_minute: org.default_start_minute,
      end_minute: org.default_end_minute,
    })),
  );
}

/**
 * Whether this schedule's hours were set by nobody. The stamp decides when it is
 * there; the seed's shape decides only for a row that predates the stamp.
 */
export function isUnsetHours(schedule: UnsetHoursSchedule, org: OrgDefaults): boolean {
  if (schedule.rules.length === 0) return false;
  if (schedule.hours_source !== null) return schedule.hours_source === "seed";
  return weekKey(schedule.timezone, schedule.rules) === seedWeekKey(org);
}

export function agentsOnUnsetHours(input: UnsetHoursInput): UnsetHoursAgent[] {
  const byUser = new Map(input.schedules.map((s) => [s.user_id, s]));
  return input.agents.filter((a) => {
    const s = byUser.get(a.id);
    return s !== undefined && isUnsetHours(s, input.org);
  });
}

const NAME_CAP = 8;
function who(a: UnsetHoursAgent): string {
  const name = a.name?.trim() || a.email || a.id;
  return a.email && a.email !== name ? `${name} (${a.email})` : name;
}

/** The page: what a lead would meet, who, and where the fix lives. */
export function formatUnsetHoursAlert(agents: UnsetHoursAgent[]): string {
  const n = agents.length;
  const lines = agents.slice(0, NAME_CAP).map(who);
  const more = n > NAME_CAP ? `\n(and ${n - NAME_CAP} more)` : "";
  return (
    `${n} bookable ${n === 1 ? "agent is" : "agents are"} being offered on working hours nobody set: the seeded ` +
    `default, which is right only by coincidence. Import their real hours with ` +
    `APPLY=1 pnpm import:calcom-schedules, or set them under admin > agent hours.\n` +
    lines.join("\n") +
    more
  );
}

/** The all clear, hung off a measured sweep that found nobody. */
export function formatUnsetHoursRecovery(): string {
  return "Every bookable agent's working hours were set by somebody: an agent, an admin, or the cal.com import. No action is needed.";
}

/**
 * The monitor lane step (#1753): read, judge, page or clear.
 *
 * Both directions hang off a MEASURED sweep. A read that throws is reported as
 * unmeasured and clears nothing: an all clear posted from a query that never ran
 * is how "the backlog has cleared" once went out over a dead read (#1152). The
 * deps are injected so scripts/test-unset-hours.ts pins that silent path with a
 * fake that fails.
 */
export interface UnsetHoursDeps {
  load: () => Promise<UnsetHoursInput>;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  resolve: (key: string, text: string) => Promise<boolean>;
  cooldownMs: number;
}

export type UnsetHoursResult =
  | { status: "unreadable"; error: string }
  | { status: "paged"; agents: UnsetHoursAgent[] }
  | { status: "clear"; measured: number };

export async function runUnsetHoursCheck(deps: UnsetHoursDeps): Promise<UnsetHoursResult> {
  let input: UnsetHoursInput;
  try {
    input = await deps.load();
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
  const agents = agentsOnUnsetHours(input);
  if (agents.length) {
    await deps.notify(AGENTS_ON_UNSET_HOURS_KEY, deps.cooldownMs, formatUnsetHoursAlert(agents));
    return { status: "paged", agents };
  }
  await deps.resolve(AGENTS_ON_UNSET_HOURS_KEY, formatUnsetHoursRecovery());
  return { status: "clear", measured: input.agents.length };
}

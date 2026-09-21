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
//
// THE GRACE. Every new hire is seeded with the default week, so the check as first
// shipped named each of them the day they went bookable and repeated every 24 hours
// until somebody edited their hours. That is a daily message about a state normal
// onboarding clears on its own, which is how an alert stops being read at all (L36).
// So the ALERT waits two days; the predicate below does not, because
// `verify:parallel-run-readiness` asks a different question (is the shadow run
// trustworthy at this instant, before real leads are sent) and wants everybody who
// is unset, however new.
//
// The age is measured from a STORED stamp, `hours_set_at` when the writer recorded
// one and the row's `created_at` for the rows written before the stamp existed, so
// it really ages (L74). A stamp nothing can read is reported rather than spared: a
// NaN comparison lands on the quiet branch by default, which would disable the
// alert silently.
import { parseStampMs } from "@/lib/date/stamp";
import type { OrgDefaults } from "@/lib/schedule-core";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

export const AGENTS_ON_UNSET_HOURS_KEY = "agents_on_unset_hours";

const DAY_MS = 24 * 60 * 60_000;

/**
 * How long an agent may sit on the seeded week before the alert names them. Two
 * days covers the ordinary case (a hire goes bookable, an admin or the cal.com
 * import sets their hours within a day) without covering a week of real leads.
 * The copy renders this number rather than spelling it out, so a change here
 * cannot leave the message claiming a window nobody enforces.
 */
export const UNSET_HOURS_GRACE_MS = 2 * DAY_MS;

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
  /** When the recorded writer wrote this week; null = written before the stamp existed. */
  hours_set_at: string | null;
  /** The row's own age, the only anchor a pre stamp row has. */
  created_at: string;
  rules: { weekday: number; start_minute: number; end_minute: number }[];
}

/** An unset agent plus when their week was last written. null = the stamp is unreadable. */
export interface UnsetHoursFinding extends UnsetHoursAgent {
  unsetSinceMs: number | null;
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

/**
 * When this week was written, by the stamp if the writer left one and by the row's
 * age otherwise. null means the date is there and unreadable, which is a finding
 * of its own rather than a reason to stay quiet.
 */
export function unsetSinceMs(schedule: UnsetHoursSchedule): number | null {
  return parseStampMs(schedule.hours_set_at ?? schedule.created_at);
}

export function agentsOnUnsetHours(input: UnsetHoursInput): UnsetHoursFinding[] {
  const byUser = new Map(input.schedules.map((s) => [s.user_id, s]));
  const out: UnsetHoursFinding[] = [];
  for (const a of input.agents) {
    const s = byUser.get(a.id);
    if (s === undefined || !isUnsetHours(s, input.org)) continue;
    out.push({ ...a, unsetSinceMs: unsetSinceMs(s) });
  }
  return out;
}

/**
 * Those the alert speaks about: unset for longer than the grace, or unset for a
 * length nothing can measure. The clock is passed in, never read here, so the
 * boundary is testable and the alert preview renders the same text every run.
 */
export function agentsPastUnsetHoursGrace(findings: UnsetHoursFinding[], nowMs: number): UnsetHoursFinding[] {
  return findings.filter((f) => f.unsetSinceMs === null || nowMs - f.unsetSinceMs > UNSET_HOURS_GRACE_MS);
}

const NAME_CAP = 8;
const GRACE_DAYS = Math.round(UNSET_HOURS_GRACE_MS / DAY_MS);

/** Who, and how long they have sat there, which is the fact that earns the message. */
function who(a: UnsetHoursFinding, nowMs: number): string {
  const name = a.name?.trim() || a.email || a.id;
  const label = a.email && a.email !== name ? `${name} (${a.email})` : name;
  const days = a.unsetSinceMs === null ? null : Math.floor((nowMs - a.unsetSinceMs) / DAY_MS);
  const how = days === null ? "since an unreadable date" : `${days} ${days === 1 ? "day" : "days"}`;
  return `${label}, ${how}`;
}

/** The page: what a lead would meet, who, how long, and where the fix lives. */
export function formatUnsetHoursAlert(agents: UnsetHoursFinding[], nowMs: number): string {
  const n = agents.length;
  // Longest first, so the one nobody has got to in a month leads. An unreadable
  // stamp sorts to the front for the same reason: it is the least understood.
  const longestFirst = [...agents].sort((a, b) => (a.unsetSinceMs ?? 0) - (b.unsetSinceMs ?? 0));
  const lines = longestFirst.slice(0, NAME_CAP).map((a) => who(a, nowMs));
  const more = n > NAME_CAP ? `\n(and ${n - NAME_CAP} more)` : "";
  return (
    `${n} bookable ${n === 1 ? "agent has" : "agents have"} spent more than ${GRACE_DAYS} days on working hours ` +
    `nobody set: the seeded default, which is right only by coincidence. Import their real hours with ` +
    `APPLY=1 pnpm import:calcom-schedules, or set them under admin > agent hours.\n` +
    lines.join("\n") +
    more
  );
}

/**
 * The all clear, hung off a measured sweep that found nobody past the grace. It
 * names the window, because "nobody is past two days" and "everybody's hours are
 * set" are different facts and only the first one was measured (L440).
 */
export function formatUnsetHoursRecovery(): string {
  return (
    `No bookable agent has spent more than ${GRACE_DAYS} days on the seeded default working hours. ` +
    `Anyone seeded inside that window is not counted yet.`
  );
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
  notify: ThrottledNotify;
  resolve: AlertResolve;
  cooldownMs: number;
  /** Passed in so the grace boundary is drivable and the copy is deterministic. */
  nowMs: number;
}

export type UnsetHoursResult =
  | { status: "unreadable"; error: string }
  | { status: "paged"; agents: UnsetHoursFinding[] }
  | { status: "clear"; measured: number };

export async function runUnsetHoursCheck(deps: UnsetHoursDeps): Promise<UnsetHoursResult> {
  let input: UnsetHoursInput;
  try {
    input = await deps.load();
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
  const agents = agentsPastUnsetHoursGrace(agentsOnUnsetHours(input), deps.nowMs);
  if (agents.length) {
    await deps.notify(AGENTS_ON_UNSET_HOURS_KEY, deps.cooldownMs, formatUnsetHoursAlert(agents, deps.nowMs));
    return { status: "paged", agents };
  }
  await deps.resolve(AGENTS_ON_UNSET_HOURS_KEY, formatUnsetHoursRecovery());
  return { status: "clear", measured: input.agents.length };
}

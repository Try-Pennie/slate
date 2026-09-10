// The reads shared by `pnpm import:calcom-schedules` (which writes cal.com's hours
// into Slate) and `pnpm verify:calcom-parity` (which checks the two still agree).
//
// They ask cal.com the same three questions and Slate the same one, and the pair
// that matters most is "who is a bookable agent": two copies of that predicate
// drift, and the moment they do, the parity command reports agreement about a
// roster the importer never wrote to.
//
// Everything here except `loadBookableRoster` is pure or takes its collaborators as
// arguments, so `scripts/test-calcom-roster.ts` drives it with no network and no
// real clock.
import type { SupabaseClient } from "@supabase/supabase-js";
import { retryDelayMs } from "./calcom-schedule-import.ts";

/**
 * Slate's `unwrap`, passed in rather than imported.
 *
 * It lives behind the `@/` alias, and importing it here would make this module
 * unloadable without the alias hook, which the offline test deliberately runs
 * without. Structural rather than a type import for the same reason.
 */
type Unwrap = <T>(res: { data: T | null; error: { message: string } | null }, context: string) => T | null;

const CAL_API = "https://api.cal.com/v2";

/** cal.com's API version. Pinned: `2024-08-13` does not have the schedules
 *  endpoint at all, and answers 404 rather than saying so. */
const CAL_API_VERSION = "2024-09-04";

export interface CalGetResult {
  status: number;
  json: unknown;
}

/**
 * A cal.com GET that survives the rate limit.
 *
 * The first real import run met 429 on 89 of 103 agents: cal.com meters this
 * endpoint hard. Every read retries on the server's own instruction (Retry-After)
 * or an exponential backoff, and the ladder is finite, because a read that retries
 * forever hangs the run and a hang is worse than a failure (L110).
 *
 * `fetchImpl` and `sleep` are arguments rather than defaults captured at import,
 * so the ladder is proved by a test that finishes instantly instead of one that
 * waits for real (L524).
 */
export function makeCalGet(opts: {
  key: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): (path: string) => Promise<CalGetResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers = {
    Authorization: `Bearer ${opts.key}`,
    "cal-api-version": CAL_API_VERSION,
  };
  return async function calGet(path: string): Promise<CalGetResult> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${CAL_API}${path}`, { headers });
      } catch (err) {
        // A thrown fetch is a transport fault, the same class as a 5xx, so it
        // climbs the same ladder. When the ladder ends it is RE-THROWN rather than
        // reported as a status: a synthesised status is indistinguishable from one
        // cal.com actually sent, and the caller would classify an outage on our
        // side as a refusal on theirs.
        const wait = retryDelayMs(503, null, attempt);
        if (wait === null) throw err;
        await sleep(wait);
        continue;
      }
      if (res.ok) return { status: res.status, json: await res.json().catch(() => null) };
      const wait = retryDelayMs(res.status, res.headers.get("retry-after"), attempt);
      if (wait === null) return { status: res.status, json: null };
      await sleep(wait);
    }
  };
}

export type DefaultSchedule =
  | { kind: "schedule"; schedule: unknown }
  /** The account exists and owns no schedule. A real state, not a fault. */
  | { kind: "none" }
  /** The payload is not the shape the contract promises. Kept apart from `none`
   *  because it means the API changed under us rather than that an agent has
   *  nothing set, and those send two different people to do two different things. */
  | { kind: "unreadable"; why: string };

/**
 * Which of a user's schedules is the one their bookings are actually taken
 * against.
 *
 * cal.com returns every schedule a user owns. Comparing Slate against a holiday
 * cover week nobody books through would report drift that does not exist, so the
 * DEFAULT is taken. A lone schedule with no flag is still taken: cal.com does not
 * always set it, and refusing those would strand a real slice of this roster.
 */
export function pickDefaultSchedule(payload: unknown): DefaultSchedule {
  if (payload === null || typeof payload !== "object") {
    return { kind: "unreadable", why: "the schedules payload is not an object" };
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return { kind: "unreadable", why: "the schedules payload carries no list of schedules" };
  }
  if (data.length === 0) return { kind: "none" };
  const chosen = (data as { isDefault?: unknown }[]).find((s) => s?.isDefault === true) ?? data[0];
  return { kind: "schedule", schedule: chosen };
}

/**
 * The org's users as a lowercased email index, one read for the whole roster.
 *
 * Refused whole rather than salvaged. A half-read listing is a SMALLER index, and
 * a missing entry is reported as "this agent has no cal.com account", which is a
 * finding about the roster wearing the costume of a defect in our parsing (L340).
 */
export function emailIndex(
  payload: unknown,
): { ok: true; index: Map<string, number> } | { ok: false; why: string } {
  if (payload === null || typeof payload !== "object") {
    return { ok: false, why: "the org users payload is not an object" };
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return { ok: false, why: "the org users payload carries no list of users" };
  }
  const index = new Map<string, number>();
  for (const user of data as { id?: unknown; email?: unknown }[]) {
    if (typeof user?.email !== "string" || user.email === "") {
      return { ok: false, why: "a listed cal.com user carries no email, so the index would be short" };
    }
    if (typeof user?.id !== "number") {
      return { ok: false, why: `the cal.com user ${user.email} carries no numeric id` };
    }
    index.set(user.email.toLowerCase(), user.id);
  }
  return { ok: true, index };
}

/**
 * The cal.com event type id to read a host list from, or null when the setting
 * cannot be read.
 *
 * It is handed to a strict equality against every event type cal.com returns, so
 * `Number()` alone is not enough: an unreadable value becomes NaN, NaN matches
 * nothing, and the caller stops with "event type NaN is not among team 19546's
 * event types". True, and it sends somebody hunting for a missing event type
 * rather than for the mistyped setting they actually have (L50, L11).
 *
 * A refusal is null and NEVER the default. Falling back would read the wrong
 * event type's host list and report a confident answer about a comparison nobody
 * asked for (L214).
 */
export function readEventTypeId(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  // Matched as digits rather than parsed, because `Number` accepts "1e5", "0x10"
  // and " 12 " as numbers, and no cal.com id is ever written in any of those.
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface RosterAgent {
  id: string;
  email: string;
  scheduleId: string | null;
  timezone: string | null;
  rules: { weekday: number; start_minute: number; end_minute: number }[];
  /**
   * Who last wrote this week (`hours_source`, migration 0117), or null for a row
   * written before the stamp existed.
   *
   * Read HERE rather than by each caller, because both of them now need it and for
   * the same reason: the importer refuses to overwrite a week an agent set for
   * themselves, and the parity sweep has to report that difference as one no
   * automatic run will clear rather than paging on it daily (#2092). Two reads of
   * the same fact would be free to disagree about who owns somebody's hours.
   */
  hoursSource: string | null;
}

/**
 * Every bookable, live, non-test agent with the week Slate holds for them.
 *
 * ONE definition of "bookable agent", shared by the importer and the parity
 * command. Two copies would drift, and the drift is silent in the worst
 * direction: the command would report agreement across a roster the importer never
 * wrote to.
 *
 * An agent with no schedule row comes back with `scheduleId: null` rather than
 * being filtered out. Dropping them would make a bookable agent who is offered
 * nothing invisible to the very sweep that should report them.
 */
export async function loadBookableRoster(
  db: SupabaseClient,
  unwrap: Unwrap,
): Promise<RosterAgent[]> {
  const agents = (unwrap(
    await db
      .from("users")
      .select("id, email")
      .eq("bookable", true)
      .is("deactivated_at", null)
      .eq("is_test", false),
    "bookable agents",
  ) ?? []) as { id: string; email: string }[];
  if (agents.length === 0) return [];

  const scheds = (unwrap(
    await db
      .from("availability_schedules")
      .select("id, user_id, timezone, hours_source")
      .in("user_id", agents.map((a) => a.id)),
    "schedules",
  ) ?? []) as { id: string; user_id: string; timezone: string; hours_source: string | null }[];

  const rules = scheds.length === 0
    ? []
    : ((unwrap(
        await db
          .from("availability_rules")
          .select("schedule_id, weekday, start_minute, end_minute")
          .in("schedule_id", scheds.map((s) => s.id)),
        "rules",
      ) ?? []) as { schedule_id: string; weekday: number; start_minute: number; end_minute: number }[]);

  const schedByUser = new Map(scheds.map((s) => [s.user_id, s]));
  const rulesBySchedule = new Map<string, RosterAgent["rules"]>();
  for (const r of rules) {
    const list = rulesBySchedule.get(r.schedule_id);
    const rule = { weekday: r.weekday, start_minute: r.start_minute, end_minute: r.end_minute };
    if (list) list.push(rule);
    else rulesBySchedule.set(r.schedule_id, [rule]);
  }

  return agents.map((a) => {
    const sched = schedByUser.get(a.id);
    return {
      id: a.id,
      email: a.email,
      scheduleId: sched?.id ?? null,
      timezone: sched?.timezone ?? null,
      rules: sched ? (rulesBySchedule.get(sched.id) ?? []) : [],
      // `?? null` is the SCHEDULE being absent, not an unreadable stamp: an agent
      // with no schedule row has no week for anybody to have written.
      hoursSource: sched?.hours_source ?? null,
    };
  });
}

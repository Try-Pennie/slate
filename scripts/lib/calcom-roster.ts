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
import { retryDelayMs, retryAfterMs, CAL_SCHEDULES_API_VERSION } from "@/lib/calcom/schedule-import";
import { selectAllPages } from "@/lib/supabase/paginate";
import { realAdvisorsOnly } from "@/lib/advisors/real-advisor";
// `pickDefaultSchedule` moved to `src/lib/calcom/schedule-import.ts` (#2627), because
// the activation path in the Worker now reads a default schedule too and one choice
// of "which schedule" must serve both.

/**
 * Slate's `unwrap`, passed in rather than imported.
 *
 * It lives behind the `@/` alias, and importing it here would make this module
 * unloadable without the alias hook, which the offline test deliberately runs
 * without. Structural rather than a type import for the same reason.
 */
type Unwrap = <T>(res: { data: T | null; error: { message: string } | null }, context: string) => T | null;

const CAL_API = "https://api.cal.com/v2";

/**
 * cal.com's API version, per endpoint family, and the two are NOT
 * interchangeable: `2024-08-13` does not have the schedules endpoint at all and
 * answers 404 rather than saying so, and the bookings endpoint answers only under
 * its own. Both were measured live rather than read off documentation, because
 * the last time a cal.com capability was assumed rather than measured the probe
 * built on it shipped structurally unable to run (#1754).
 */
export { CAL_SCHEDULES_API_VERSION };
/** `GET /bookings/{uid}`, measured live 2026-09-11. */
export const CAL_BOOKINGS_API_VERSION = "2024-08-13";

export interface CalGetResult {
  status: number;
  json: unknown;
  /** cal.com's Retry-After on a refusal the ladder gave up on, so a later read can
   *  honour it (#3963). Absent on an answer. */
  retryAfter?: string | null;
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
  /** The version this reader sends when a call does not name its own. Defaults to
   *  the schedules one, so every existing caller is unchanged. */
  apiVersion?: string;
}): (path: string, apiVersion?: string) => Promise<CalGetResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const defaultVersion = opts.apiVersion ?? CAL_SCHEDULES_API_VERSION;
  // Per CALL rather than per reader (#2240), because one command now reads two
  // endpoint families that answer under different versions, and a second reader
  // would be a second retry ladder and a second place for the key to live.
  return async function calGet(path: string, apiVersion?: string): Promise<CalGetResult> {
    const headers = {
      Authorization: `Bearer ${opts.key}`,
      "cal-api-version": apiVersion ?? defaultVersion,
    };
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
      if (wait === null) return { status: res.status, json: null, retryAfter: res.headers.get("retry-after") };
      await sleep(wait);
    }
  };
}

/**
 * One agent's cal.com read, as the sweep and the import consume it: an answer
 * (any status), or a transport fault the ladder could not ride out.
 */
export type CalRead =
  | ({ kind: "answered" } & CalGetResult)
  | { kind: "threw"; error: unknown };

/**
 * Whether a read earns a second attempt after the sweep (#3963). A rate limit only.
 *
 * Five of seven daily parity runs ended with exactly three agents unmeasured, a
 * different three each day, every one a 429 that had already climbed the whole
 * ladder. The ladder retries INSIDE the burst that caused the refusal, a few
 * seconds apart; a read made after the sweep is over, once cal.com's window has
 * passed, is a different attempt and usually answers.
 *
 * Nothing else earns one. A 5xx or a thrown fetch already climbed the same ladder
 * as a transport fault, and a 4xx that is not a rate limit cannot be fixed by
 * asking again: another read cannot create a schedule that is not there.
 */
export function earnsSecondRead(read: CalRead): boolean {
  return read.kind === "answered" && read.status === 429;
}

/**
 * The wait before the second read, when cal.com did not ask for longer.
 *
 * cal.com's API meters keys per MINUTE, so a full minute after the last refusal
 * is a fresh window whatever the rest of the sweep spent. It is counted from the
 * end of the sweep rather than from the refusal, so it can only ever be longer
 * than needed, never early. It costs a minute on a day cal.com refused somebody
 * and nothing on a day it did not, inside a job whose timeout is 25 minutes.
 */
export const SECOND_READ_BACKOFF_MS = 60_000;
/** The most a Retry-After may make the second pass wait, so one absurd header
 *  cannot spend the job's timeout sleeping. A refusal still standing after it is
 *  reported unmeasured, as it always was. */
export const SECOND_READ_MAX_WAIT_MS = 5 * 60_000;

/**
 * How long to wait before the second pass: cal.com's longest Retry-After when it
 * asked for more than the backoff, otherwise the backoff.
 *
 * A Retry-After SHORTER than the backoff does not win, because the ladder already
 * honoured it on every rung and was still refused, which is the measured proof it
 * was not enough.
 */
export function secondReadWaitMs(refused: readonly CalRead[]): number {
  let wait = SECOND_READ_BACKOFF_MS;
  for (const r of refused) {
    if (r.kind !== "answered") continue;
    const asked = retryAfterMs(r.retryAfter);
    if (asked !== null && asked > wait) wait = asked;
  }
  return Math.min(wait, SECOND_READ_MAX_WAIT_MS);
}

export interface SecondReadOutcome<T> {
  /** Every item's final read: the second one where there was one. */
  reads: Map<T, CalRead>;
  /** Items cal.com rate limited on the first pass, so read again. */
  retried: number;
  /** Of those, how many were not rate limited the second time. */
  recovered: number;
  /** The wait before the second pass, or null when there was none. */
  waitedMs: number | null;
}

/**
 * Read every item once, paced, then read each rate limited one once more after a
 * backoff (#3963). Shared by `pnpm verify:calcom-parity` and
 * `pnpm import:calcom-schedules`, which read the same endpoint in the same lane
 * and meet the same refusals: one rule, so the two cannot drift into retrying
 * differently (L370).
 *
 * `sleep` is an argument so this is driven offline with recorded waits (L524).
 * Pacing comes BEFORE each read, so the first one pays it too, as both callers
 * always did. The single backoff stands in for the second pass's first pace.
 * A read that throws is recorded rather than raised, so one agent's transport
 * fault cannot end the run.
 */
export async function readEachWithSecondRead<T>(
  items: readonly T[],
  read: (item: T) => Promise<CalGetResult>,
  opts: { sleep: (ms: number) => Promise<void>; paceMs: number },
): Promise<SecondReadOutcome<T>> {
  const attempt = async (item: T): Promise<CalRead> => {
    try {
      return { kind: "answered", ...(await read(item)) };
    } catch (error) {
      return { kind: "threw", error };
    }
  };
  const reads = new Map<T, CalRead>();
  for (const item of items) {
    await opts.sleep(opts.paceMs);
    reads.set(item, await attempt(item));
  }
  const refused = items.filter((item) => earnsSecondRead(reads.get(item)!));
  if (refused.length === 0) return { reads, retried: 0, recovered: 0, waitedMs: null };

  const waitedMs = secondReadWaitMs(refused.map((item) => reads.get(item)!));
  let recovered = 0;
  for (const [i, item] of refused.entries()) {
    await opts.sleep(i === 0 ? waitedMs : opts.paceMs);
    const again = await attempt(item);
    // Read twice and no more. Still refused stays unmeasured, exactly as before.
    if (!earnsSecondRead(again)) recovered++;
    reads.set(item, again);
  }
  return { reads, retried: refused.length, recovered, waitedMs };
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
    await realAdvisorsOnly(db.from("users").select("id, email").eq("bookable", true).is("deactivated_at", null)),
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

  // PAGED, unlike the two reads above (#2416). Those are one row per agent and
  // bounded by the roster; this is one row per agent per weekday window, 793 on
  // 2026-10-02 and past PostgREST's 1,000 row page at the 200 agent target. An
  // unpaged read returns the first page and says nothing, so every agent whose
  // rules fell past it would come back holding a shorter week: the parity command
  // reports days that are not missing and the importer diffs a week it never
  // fully loaded. Ordered by `id` so the pages are disjoint and cover the whole
  // set, and `selectAllPages` throws on a failed page rather than returning the
  // rows it had, since a short list is the very defect being prevented.
  const scheduleIds = scheds.map((s) => s.id);
  const rules = scheds.length === 0
    ? []
    : await selectAllPages<{ schedule_id: string; weekday: number; start_minute: number; end_minute: number }>(
        "rules",
        "id",
        () =>
          db
            .from("availability_rules")
            .select("id, schedule_id, weekday, start_minute, end_minute")
            .in("schedule_id", scheduleIds),
      );

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

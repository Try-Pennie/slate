import { DateTime } from "luxon";
import { windowOnDate, type BusinessHoursException } from "../booking/business-hours.ts";

/** Working-hours window for one weekday (1=Mon..7=Sun), minutes from midnight. */
export interface WorkingRule {
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export interface MemberAvailability {
  userId: string;
  timezone: string;
  rules: WorkingRule[];
  /** Busy intervals as epoch-ms [start, end). Slate + gcal merged. */
  busy: { start: number; end: number }[];
  /** Confirmed booking start instants (epoch-ms), for the daily cap. Used only
   *  when `dayCounts` is absent (the in-place reschedule / reassign paths). */
  bookingStartsMs: number[];
  /** #832: precomputed local-date -> count for the daily cap, from the server-side
   *  RPC. When present it IS the cap count; otherwise it is derived from
   *  `bookingStartsMs`. An empty map means zero bookings (still authoritative). */
  dayCounts?: Map<string, number>;
}

/**
 * Stitch the per-bucket availability reads (schedules, rules, busy_blocks,
 * bookings) into one MemberAvailability per user, in `userIds` order. Pure, and
 * O(N+M): it indexes each read by its key once, instead of re-scanning every
 * read for every user (the old O(users × blocks) `.filter()` join) — the cold
 * availability recompute walks ~70 agents, so the quadratic scan added up (#249).
 * A user with no schedule falls back to America/New_York with no working rules.
 */
export function assembleMemberAvailability(
  userIds: string[],
  schedules: { id: string; user_id: string; timezone: string }[],
  rules: { schedule_id: string; weekday: number; start_minute: number; end_minute: number }[],
  busy: { user_id: string; starts_at: string; ends_at: string }[],
  dayCountsByUser: Map<string, Map<string, number>>,
): MemberAvailability[] {
  const scheduleByUser = new Map<string, { id: string; timezone: string }>();
  for (const s of schedules) scheduleByUser.set(s.user_id, { id: s.id, timezone: s.timezone });

  const rulesBySchedule = new Map<string, WorkingRule[]>();
  for (const r of rules) {
    const list = rulesBySchedule.get(r.schedule_id) ?? [];
    list.push({ weekday: r.weekday, start_minute: r.start_minute, end_minute: r.end_minute });
    rulesBySchedule.set(r.schedule_id, list);
  }

  const busyByUser = new Map<string, { start: number; end: number }[]>();
  for (const b of busy) {
    const list = busyByUser.get(b.user_id) ?? [];
    list.push({ start: Date.parse(b.starts_at), end: Date.parse(b.ends_at) });
    busyByUser.set(b.user_id, list);
  }

  return userIds.map((userId) => {
    const schedule = scheduleByUser.get(userId);
    // The RPC bucketed with the SAME per-agent tz this member carries (the caller
    // passed it in), so the cap count and the slot-day lookup can't diverge (#832).
    return {
      userId,
      timezone: schedule?.timezone ?? "America/New_York",
      rules: schedule ? (rulesBySchedule.get(schedule.id) ?? []) : [],
      busy: busyByUser.get(userId) ?? [],
      bookingStartsMs: [],
      dayCounts: dayCountsByUser.get(userId) ?? new Map<string, number>(),
    } satisfies MemberAvailability;
  });
}

export interface SlotComputeInput {
  members: MemberAvailability[];
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  dailyCap: number | null;
  slotIntervalMin: number;
  /** The org's opening hours (#1295). Required for the same reason as on
   *  `SlotRules`: a new caller must not be able to omit gate 1. */
  businessHours: BusinessHoursRules;
  from: string; // ISO window start
  to: string; // ISO window end
  nowMs: number;
}

const MIN = 60_000;

/**
 * Wall-clock time `minutes` after local midnight on `day`, DST-correct. Uses
 * `.set` (wall clock) rather than `.plus({minutes})` (exact duration): on a DST
 * transition day, adding duration from midnight would shift the working-hours
 * window by the offset delta (e.g. 9:00 -> 10:00 on spring-forward). 1440 (24:00)
 * maps to the next local midnight.
 */
export function timeOnDay(day: DateTime, minutes: number): DateTime {
  if (minutes >= 1440) return day.plus({ days: 1 }).startOf("day");
  return day.set({
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0,
    millisecond: 0,
  });
}

/**
 * Rules-only on-shift guard (#527): true iff [startMs, endMs) fits entirely
 * inside one of the agent's shift windows for the LOCAL weekday of `startMs`.
 *
 * Deliberately reads ONLY the working-hours rules, never `busy_blocks`: the
 * in-place reschedule branch uses this alongside its own self-free check, and a
 * busy-aware check would re-count the booking's own still-present cached event as
 * a conflict — the exact #523 false-conflict the in-place branch exists to avoid.
 * DST-correct via `timeOnDay` (wall-clock set, not a duration add).
 */
export function isWithinWorkingHours(
  rules: WorkingRule[],
  timezone: string,
  startMs: number,
  endMs: number,
): boolean {
  const day = DateTime.fromMillis(startMs, { zone: timezone }).startOf("day");
  for (const rule of rules) {
    if (rule.weekday !== day.weekday) continue;
    const windowStart = timeOnDay(day, rule.start_minute).toMillis();
    const windowEnd = timeOnDay(day, rule.end_minute).toMillis();
    if (startMs >= windowStart && endMs <= windowEnd) return true;
  }
  return false;
}

/**
 * The ORG's own opening hours, in the org's own zone (#1295, gate 1 of three).
 * Structurally the same as an agent's `WorkingRule[]`, deliberately, so the gate is
 * a second call to `isWithinWorkingHours` rather than a parallel implementation of
 * the same idea. The windows are resolved and validated in
 * `@/lib/booking/business-hours`; this module stays import-free of it so the pure
 * slot core keeps running node-native.
 *
 * An EMPTY `rules` list means the org is shut every day, which is a legitimate
 * stored answer. It is also why the loader throws rather than degrading: a read
 * error must never be able to say "shut".
 */
export interface BusinessHoursRules {
  zone: string;
  rules: WorkingRule[];
  /**
   * Specific dates that override the weekly pattern (#1363), shutting a normally
   * open day or opening a normally shut one.
   *
   * REQUIRED, like `businessHours` itself is on `SlotRules` and for the same
   * reason: an optional field would let a construction site silently offer times
   * on a day the office is dark, and nothing downstream could tell. Pass `[]` for
   * "no exceptions", which is a statement rather than an omission.
   */
  exceptions: BusinessHoursException[];
}

/**
 * Is the ORG open for [startMs, endMs)? (#1295 gate 1, extended by #1363.)
 *
 * The single judge of that question. It is deliberately NOT
 * `isWithinWorkingHours(hours.rules, ...)`, which answers the WEEKLY PATTERN and
 * is exactly the question date exceptions exist to stop anybody asking: a caller
 * that reached past this would keep offering times through a holiday shutdown
 * while every test of the weekly rules stayed green.
 *
 * An agent's own hours still go through `isWithinWorkingHours`. Agents have no
 * date exceptions (their time off is a different mechanism entirely), and the two
 * windows are judged in their OWN zones and never intersected.
 */
export function isOrgOpen(hours: BusinessHoursRules, startMs: number, endMs: number): boolean {
  const day = DateTime.fromMillis(startMs, { zone: hours.zone }).startOf("day");
  const window = windowOnDate(hours, day.toISODate() ?? "", day.weekday);
  if (!window) return false;
  return (
    startMs >= timeOnDay(day, window.start_minute).toMillis() &&
    endMs <= timeOnDay(day, window.end_minute).toMillis()
  );
}

/** The per-agent slot rules a single slot is judged against (#536). */
export interface SlotRules {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  dailyCap: number | null;
  /**
   * REQUIRED (#1295) so `tsc` enumerates every construction site, now and forever.
   * A slot the org is closed for must never be offered by any path, and an optional
   * field would let a new caller silently skip the gate.
   */
  businessHours: BusinessHoursRules;
}

/** Bucket booking start instants by the agent's LOCAL calendar date. */
function bookingsPerLocalDay(
  bookingStartsMs: number[],
  timezone: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ms of bookingStartsMs) {
    const key = DateTime.fromMillis(ms, { zone: timezone }).toISODate();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether the agent is under their daily cap for the LOCAL day of `startMs`.
 * `dailyCap === null` means uncapped. `dayCounts` may be a precomputed
 * local-date -> count map (the booker's hot loop builds it once); otherwise the
 * count is derived from `bookingStartsMs`.
 *
 * THE CAP IS A SOFT LIMIT, and that is a decision rather than an oversight (#1048).
 * Enforcement is check-then-act: this counts, and the insert happens after. Two
 * bookings for DIFFERENT slots on the same local day can therefore both pass the
 * count and both insert, so an agent can end a day one or two over their cap. The
 * active-slot unique index only arbitrates the same slot, which is the case that
 * matters (two people cannot take one appointment).
 *
 * Making it hard would mean counting and inserting inside one transaction with the
 * agent row locked, or an advisory lock keyed on agent plus day, on the booking
 * insert: the highest risk path in the system. That was weighed against what the
 * softness costs, which is an agent seeing one extra call on a busy day, and the
 * softness won. It is a workload preference, not a correctness boundary: nothing
 * downstream reads the cap as a guarantee, and no double booking can come from it.
 *
 * Revisit if the cap ever becomes a compliance or contractual limit rather than a
 * workload one, because then a soft ceiling is the wrong shape entirely.
 */
export function isUnderDailyCap(
  bookingStartsMs: number[],
  timezone: string,
  startMs: number,
  dailyCap: number | null,
  dayCounts?: Map<string, number>,
): boolean {
  if (dailyCap === null) return true;
  const dayKey = DateTime.fromMillis(startMs, { zone: timezone }).toISODate();
  return underCapOn(dayKey, bookingStartsMs, timezone, dailyCap, dayCounts);
}

/** The cap decision once the agent's local date is known (#2806). */
function underCapOn(
  dayKey: string | null,
  bookingStartsMs: number[],
  timezone: string,
  dailyCap: number,
  dayCounts?: Map<string, number>,
): boolean {
  if (dayKey === null) return true;
  const counts = dayCounts ?? bookingsPerLocalDay(bookingStartsMs, timezone);
  return (counts.get(dayKey) ?? 0) < dailyCap;
}

/**
 * One local calendar day on which the zone's offset never changes (#2806): the
 * ground the per day shortcuts below stand on.
 *
 * Profiled on 2026-10-14 (80 agents, 7 days, the live 20 minute call on a 10 minute
 * grid), about 90 percent of `computeBucketSlots` was Luxon resolving a zone offset
 * through `Intl`: stepping the grid with `DateTime.plus` and, inside the predicate,
 * re-deriving the local day, the shift windows and the date for the cap on every
 * slot. Every one of those answers is the same for every instant of one local day.
 *
 * It is built only for a day whose offset is the SAME at its first and last
 * millisecond. On such a day every instant reads the same local date, and the start
 * of day `isWithinWorkingHours` and `isOrgOpen` derive from any of them is `day`
 * itself (same instant, same offset), so a window `timeOnDay` resolves from it is the
 * one they would resolve. A day with a clock change in it gets nothing and is judged
 * the general way, instant by instant, exactly as before.
 */
interface SteadyDay {
  day: DateTime;
  startMs: number;
  /** Exclusive: 24 hours on, which is this date's end because the offset is steady. */
  endMs: number;
  isoDate: string;
}

const DAY_MS_LOCAL = 24 * 60 * MIN;

function steadyDay(zone: string, instantMs: number): SteadyDay | undefined {
  const day = DateTime.fromMillis(instantMs, { zone }).startOf("day");
  const isoDate = day.toISODate();
  if (!day.isValid || isoDate === null) return undefined;
  const startMs = day.toMillis();
  const endMs = startMs + DAY_MS_LOCAL;
  // One offset at both ends, and the last instant still on this date. A day whose
  // midnight does not exist starts at 01:00, so with an unchanged offset its last
  // millisecond is tomorrow's 00:59 and this refuses it too. This asks whether ONE
  // zone's clock moves within a day, not whether two zones keep the same clock,
  // which is `zonesKeepSameClock`'s question (#2128) and is not asked here.
  const offsetAtMidnight = day.offset;
  const last = DateTime.fromMillis(endMs - 1, { zone });
  if (last.offset !== offsetAtMidnight || last.toISODate() !== isoDate) return undefined;
  return { day, startMs, endMs, isoDate };
}

/**
 * `timeOnDay(steady.day, minutes)` as an instant, without asking Luxon when it need
 * not. On a steady day local midnight is `startMs` and the offset never moves, so
 * the wall clock `minutes` after it is exactly `minutes` later. 24:00 (the next
 * day's start, where the NEXT day's clock change can sit) and anything that is not a
 * whole minute of the day still go through `timeOnDay` itself.
 */
function steadyWallClockMs(steady: SteadyDay, minutes: number): number {
  if (Number.isInteger(minutes) && minutes >= 0 && minutes < 1440) return steady.startMs + minutes * MIN;
  return timeOnDay(steady.day, minutes).toMillis();
}

/**
 * What the slot walk has already worked out about ONE of the agent's local days
 * (#2806), so the per slot predicate need not ask Luxon again for every candidate.
 * Valid only for an instant inside `[startMs, endMs)`; `bookableSlotReason` judges
 * any other instant the general way, so a caller can never get a different answer
 * by handing it facts, only a faster one.
 */
export interface AgentLocalDay {
  startMs: number;
  endMs: number;
  /** The zone offset across the day, in minutes, as Luxon reports it. */
  offsetMin: number;
  /** The agent's local date (yyyy-mm-dd), the key the daily cap counts on. */
  isoDate: string;
  /** The agent's shift windows on this date, in rule order, as `timeOnDay` resolves them. */
  shiftWindows: { start: number; end: number }[];
}

/**
 * Build the facts for the agent's local date containing `instantMs`, or undefined
 * when that date has a clock change in it (or cannot be read), in which case the
 * caller judges each slot the general way.
 */
export function agentLocalDay(
  rules: WorkingRule[],
  timezone: string,
  instantMs: number,
): AgentLocalDay | undefined {
  const steady = steadyDay(timezone, instantMs);
  if (steady === undefined) return undefined;
  const { day, startMs, endMs, isoDate } = steady;
  const shiftWindows: { start: number; end: number }[] = [];
  for (const rule of rules) {
    if (rule.weekday !== day.weekday) continue;
    shiftWindows.push({
      start: steadyWallClockMs(steady, rule.start_minute),
      end: steadyWallClockMs(steady, rule.end_minute),
    });
  }
  return { startMs, endMs, offsetMin: day.offset, isoDate, shiftWindows };
}

/**
 * `isOrgOpen`, remembering each steady org day it has resolved (#2806), for a caller
 * asking about many instants against one week: the slot walk asks about every
 * distinct start it meets, which on a 7 day window over the roster's zones is over a
 * thousand, each paying the zone conversion again for the same eight or so days.
 *
 * The verdict is `isOrgOpen`'s by construction: inside a steady day the date, the
 * weekday, the window `windowOnDate` picks and its resolved edges are what `isOrgOpen`
 * derives for any instant of it, and an instant on a day with a clock change is
 * handed to `isOrgOpen` itself. Like `memoisedOrgOpen` it must not outlive the
 * request: it holds the hours it was built with.
 */
export function orgOpenByDay(hours: BusinessHoursRules): OrgOpenJudge {
  const days: { startMs: number; endMs: number; window: { start: number; end: number } | null }[] = [];
  return (startMs, endMs) => {
    let known = days.find((d) => startMs >= d.startMs && startMs < d.endMs);
    if (known === undefined) {
      const steady = steadyDay(hours.zone, startMs);
      if (steady === undefined) return isOrgOpen(hours, startMs, endMs);
      const w = windowOnDate(hours, steady.isoDate, steady.day.weekday);
      known = {
        startMs: steady.startMs,
        endMs: steady.endMs,
        window: w
          ? {
              start: steadyWallClockMs(steady, w.start_minute),
              end: steadyWallClockMs(steady, w.end_minute),
            }
          : null,
      };
      days.push(known);
    }
    return known.window !== null && startMs >= known.window.start && endMs <= known.window.end;
  };
}

/**
 * The one predicate that decides whether a single agent can take a single slot
 * (#536). Enforces ALL of: on-shift working hours, minimum notice, daily cap,
 * and buffer-before/after free. Both the booker's slot computation
 * (`memberOpenStarts`) and the in-place reschedule guard run THIS, so the two
 * paths can't drift — a reschedule can never keep an agent on a slot the booker
 * would never have offered.
 *
 * `opts.ignoreBusy` excludes one busy interval (the booking's OWN still-present
 * event) so a sub-event-length in-place reschedule isn't a self-conflict (#523).
 * `opts.dayCounts` lets the booker pass a precomputed per-day count for speed.
 */
/**
 * The specific slot rule an agent fails, in the order the predicate checks them:
 * `min_notice` -> `business_hours` -> `working_hours` -> `daily_cap` -> `buffer` (a
 * busy block inside the buffered window, i.e. a calendar conflict). `null` means
 * bookable.
 *
 * `business_hours` is the ORG being shut (#1295); `working_hours` is this agent
 * being off shift. They are separate answers because they are separate fixes: one
 * is an admin widening the org's day, the other is a roster change.
 */
export type UnbookableReason =
  | "min_notice"
  | "business_hours"
  | "working_hours"
  | "daily_cap"
  | "buffer";

/**
 * Like `isBookableSlotForAgent` but returns WHICH rule failed (or `null` when
 * bookable), so a declined in-place reschedule can log the specific reason (#543)
 * instead of a generic no-availability error. This is the single source of truth;
 * `isBookableSlotForAgent` is just `bookableSlotReason(...) === null`, so the
 * boolean and the reason can never drift.
 */
export function bookableSlotReason(
  m: Pick<MemberAvailability, "timezone" | "rules" | "busy" | "bookingStartsMs">,
  rules: SlotRules,
  startMs: number,
  nowMs: number,
  opts?: {
    ignoreBusy?: { start: number; end: number };
    dayCounts?: Map<string, number>;
    enforceDailyCap?: boolean;
    businessOpen?: Map<number, boolean>;
    /** Who answers gate 1 on a `businessOpen` miss: `orgOpenByDay` over the SAME
     *  `rules.businessHours` (#2806). Absent, it is `isOrgOpen` directly. */
    orgOpen?: OrgOpenJudge;
    /** Facts about the agent's local day built by `agentLocalDay` for THIS member's
     *  rules and zone (#2806). Consulted only for an instant inside its range. */
    localDay?: AgentLocalDay;
  },
): UnbookableReason | null {
  const endMs = startMs + rules.durationMin * MIN;
  if (startMs < nowMs + rules.minNoticeMin * MIN) return "min_notice";
  // Gate 1 (#1295): the org's own day, judged in the ORG's zone. This is a second,
  // independent call to the same predicate the agent's shift uses. The two windows
  // are never intersected. Clipping the agent's minutes against the org's would be
  // correct only for an agent in the business zone: for anyone else it refuses a
  // morning that is really inside the org's day and admits an evening that is really
  // past its close. Every live agent is Eastern today, so nothing in production
  // could tell the two implementations apart; `scripts/test-business-hours-gate.ts`
  // exists because of that.
  //
  // The org's answer does NOT depend on the member, so the booker's hot loop asks
  // the same question once per instant per agent: 200 identical answers at 200
  // agents. `opts.businessOpen` lets the caller memoize it across the pass, the same
  // seam `opts.dayCounts` uses. The verdict is identical either way; skipping the
  // memo just pays Luxon again (measured: +47% CPU over the whole slot loop at 200
  // agents on a 4-day horizon, which matters on the shared every-minute invocation).
  // Keying on `startMs` alone is safe because `durationMin` is fixed for one pass.
  const bh = rules.businessHours;
  const memo = opts?.businessOpen;
  let orgOpen = memo?.get(startMs);
  if (orgOpen === undefined) {
    orgOpen = opts?.orgOpen ? opts.orgOpen(startMs, endMs) : isOrgOpen(bh, startMs, endMs);
    memo?.set(startMs, orgOpen);
  }
  if (!orgOpen) return "business_hours";
  // #2806: the same two questions, answered from the day's facts when the walk has
  // them for this instant. Outside their range (or without them) it is the general
  // per instant derivation, unchanged.
  const ld = opts?.localDay;
  const onDay = ld !== undefined && startMs >= ld.startMs && startMs < ld.endMs;
  const onShift = onDay
    ? ld.shiftWindows.some((w) => startMs >= w.start && endMs <= w.end)
    : isWithinWorkingHours(m.rules, m.timezone, startMs, endMs);
  if (!onShift) return "working_hours";
  if (
    (opts?.enforceDailyCap ?? true) &&
    rules.dailyCap !== null &&
    !(onDay
      ? underCapOn(ld.isoDate, m.bookingStartsMs, m.timezone, rules.dailyCap, opts?.dayCounts)
      : isUnderDailyCap(m.bookingStartsMs, m.timezone, startMs, rules.dailyCap, opts?.dayCounts))
  ) {
    return "daily_cap";
  }
  const winStart = startMs - rules.bufferBeforeMin * MIN;
  const winEnd = endMs + rules.bufferAfterMin * MIN;
  const ig = opts?.ignoreBusy;
  for (const b of m.busy) {
    const os = Math.max(b.start, winStart);
    const oe = Math.min(b.end, winEnd);
    if (os >= oe) continue; // no overlap with the buffered window
    // The part of this busy interval overlapping our window lies entirely within
    // the ignored own event (#523) — not a real conflict. Mirrors hasBlockingBusy.
    if (ig && os >= ig.start && oe <= ig.end) continue;
    return "buffer";
  }
  return null;
}

export function isBookableSlotForAgent(
  m: Pick<MemberAvailability, "timezone" | "rules" | "busy" | "bookingStartsMs">,
  rules: SlotRules,
  startMs: number,
  nowMs: number,
  opts?: {
    ignoreBusy?: { start: number; end: number };
    dayCounts?: Map<string, number>;
    enforceDailyCap?: boolean;
    businessOpen?: Map<number, boolean>;
    orgOpen?: OrgOpenJudge;
    localDay?: AgentLocalDay;
  },
): boolean {
  return bookableSlotReason(m, rules, startMs, nowMs, opts) === null;
}

/**
 * Keep only the slot instants the ORG is open for (#1296), judged by the SAME
 * predicate gate 1 uses at compute time, so the read-time filter and the
 * compute-time gate can never give different answers.
 *
 * This exists because gate 1 alone leaves one hole: a slot computed under a wider
 * window and then served from the slot cache after someone narrows the day. The
 * read filters it out immediately, so correctness does not wait for a recompute.
 *
 * An instant that cannot be read is DROPPED, not served. A slot list is not a
 * trustworthy input the moment one of its entries is unparseable, and dropping is
 * the direction that can only ever offer less.
 */
/**
 * Whether the org is open for one window. The seam `slotsWithinBusinessHours` and
 * the availability grid take, so a caller can hand them a memo instead (#1846).
 */
export type OrgOpenJudge = (startMs: number, endMs: number) => boolean;

/**
 * The same judge, asked at most once per distinct window (#1846).
 *
 * `/admin/availability` walks 62 cached bucket rows holding 11,384 slot strings
 * and asked about every one, which measured 2.0 to 2.4 seconds of Worker CPU per
 * page view. The answer depends only on the window against a week that is fixed
 * for the request, and a start time is the SAME instant in most of the sixty
 * buckets, so nearly all of those questions were repeats.
 *
 * THE KEY IS THE WHOLE WINDOW, start and end, not the hour or the day. A memo
 * keyed on less would be fast and wrong in exactly the cases a uniform fixture
 * never has: a date closed against the weekly pattern, and a window that begins
 * inside the day but runs past the close.
 *
 * IT MUST NOT OUTLIVE THE REQUEST. The hours it is computed against are read per
 * request and can change between them (#1296 is the whole reason the org window
 * is applied at read time), so this is a function a caller builds and discards,
 * never a module level cache.
 */
export function memoisedOrgOpen(judge: OrgOpenJudge): OrgOpenJudge {
  const seen = new Map<string, boolean>();
  return (startMs, endMs) => {
    const key = `${startMs}:${endMs}`;
    const hit = seen.get(key);
    if (hit !== undefined) return hit;
    const answer = judge(startMs, endMs);
    seen.set(key, answer);
    return answer;
  };
}

export function slotsWithinBusinessHours(
  slots: string[],
  durationMin: number,
  hours: BusinessHoursRules,
  /**
   * Who decides. Defaults to asking directly, which is what every caller with a
   * single list wants; a caller walking MANY lists against one week passes a
   * `memoisedOrgOpen` so the repeats across those lists cost nothing.
   */
  judge?: OrgOpenJudge,
): string[] {
  const durMs = durationMin * MIN;
  const decide = judge ?? ((s: number, e: number) => isOrgOpen(hours, s, e));
  return slots.filter((iso) => {
    // parse-ok: an unreadable instant fails this check and is dropped from the
    // offered list, so NaN can only ever remove a slot, never admit one.
    const startMs = Date.parse(iso);
    if (!Number.isFinite(startMs)) return false;
    // Through the same judge the gate uses, so a date exception (#1363) filters a
    // cached slot on the very next request rather than at the next recompute.
    return decide(startMs, startMs + durMs);
  });
}

/** Open start instants for a single member within the window. */
function memberOpenStarts(
  m: MemberAvailability,
  input: SlotComputeInput,
  businessOpen?: Map<number, boolean>,
  orgOpen?: OrgOpenJudge,
): Set<number> {
  const open = new Set<number>();
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const durMs = input.durationMin * MIN;
  const stepMs = input.slotIntervalMin * MIN;
  const rules: SlotRules = {
    durationMin: input.durationMin,
    bufferBeforeMin: input.bufferBeforeMin,
    bufferAfterMin: input.bufferAfterMin,
    minNoticeMin: input.minNoticeMin,
    dailyCap: input.dailyCap,
    businessHours: input.businessHours,
  };

  const rulesByDay = new Map<number, WorkingRule[]>();
  for (const r of m.rules) {
    const list = rulesByDay.get(r.weekday) ?? [];
    list.push(r);
    rulesByDay.set(r.weekday, list);
  }

  // Pre-count bookings per local day once; shared with the cap check below and
  // passed to the predicate so the per-slot daily-cap decision isn't recomputed.
  // Prefer the server-side count (#832) when present; an empty map is authoritative
  // (zero bookings), so use nullish presence, not truthiness/size.
  const dayCounts = m.dayCounts ?? bookingsPerLocalDay(m.bookingStartsMs, m.timezone);

  // Iterate local calendar days spanning the window.
  let day = DateTime.fromMillis(fromMs, { zone: m.timezone }).startOf("day");
  const lastDay = DateTime.fromMillis(toMs, { zone: m.timezone }).startOf("day");

  while (day <= lastDay) {
    const dayKey = day.toISODate();
    // Whole-day skip when already at the cap — a perf gate over the same dayCounts
    // the predicate consults, so it can't disagree with the per-slot decision.
    const capped =
      input.dailyCap !== null &&
      dayKey !== null &&
      (dayCounts.get(dayKey) ?? 0) >= input.dailyCap;

    const dayRules = capped ? [] : (rulesByDay.get(day.weekday) ?? []);
    // #2806: built once per local day rather than re-derived per slot. Undefined on a
    // day with a clock change, where the predicate judges each slot the general way.
    const localDay = dayRules.length > 0 ? agentLocalDay(m.rules, m.timezone, day.toMillis()) : undefined;
    // When `day` IS the facts' day (same instant, same offset, so the same Luxon state)
    // its shift windows are already resolved, in this same rule order: `dayRules` and
    // `shiftWindows` both keep the rules of this weekday in `m.rules` order.
    const sameDay =
      localDay !== undefined && localDay.startMs === day.toMillis() && localDay.offsetMin === day.offset;
    for (let i = 0; i < dayRules.length; i++) {
      const rule = dayRules[i]!;
      const resolved = sameDay ? localDay.shiftWindows[i] : undefined;
      const windowStartMs = resolved ? resolved.start : timeOnDay(day, rule.start_minute).toMillis();
      const windowEndMs = resolved ? resolved.end : timeOnDay(day, rule.end_minute).toMillis();

      // Stepped in plain milliseconds (#2806). The old walk's `slot.plus({ minutes })`
      // and `plus({ milliseconds })` are exact duration adds (Luxon moves the instant,
      // never the wall clock, for units below a day), so this visits the same instants
      // without a zone lookup per step. The WINDOW edges stay wall clock, above.
      for (let startMs = windowStartMs; startMs + durMs <= windowEndMs; startMs += stepMs) {
        const endMs = startMs + durMs;
        const inWindow = startMs >= fromMs && endMs <= toMs;
        if (
          inWindow &&
          isBookableSlotForAgent(m, rules, startMs, input.nowMs, {
            dayCounts,
            businessOpen,
            orgOpen,
            localDay,
          })
        ) {
          open.add(startMs);
        }
      }
    }
    day = day.plus({ days: 1 });
  }

  return open;
}

/**
 * A slot is offered if AT LEAST ONE active member is free for it (round-robin
 * union). Returns sorted, de-duplicated ISO start instants. Pure in-memory math
 * over cached data — no external calls, so the embed modal loads instantly.
 */
export function computeBucketSlots(input: SlotComputeInput): string[] {
  const union = new Set<number>();
  // One org-hours verdict per instant, shared across every member (#1295): the org
  // is open or shut regardless of whose diary we are looking at. Scoped to this call
  // so it can never outlive a change to the stored hours.
  const businessOpen = new Map<number, boolean>();
  // And on a miss, one resolution per org DAY rather than per instant (#2806).
  const orgOpen = orgOpenByDay(input.businessHours);
  for (const m of input.members) {
    for (const ms of memberOpenStarts(m, input, businessOpen, orgOpen)) union.add(ms);
  }
  return [...union].sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
}

/** Which members are free for a specific instant — used for round-robin pick. */
export function freeMembersForSlot(
  members: MemberAvailability[],
  input: Omit<SlotComputeInput, "from" | "to" | "members">,
  startMs: number,
): string[] {
  return members
    .filter((m) => {
      const window: SlotComputeInput = {
        ...input,
        members: [m],
        from: new Date(startMs).toISOString(),
        to: new Date(startMs + input.durationMin * MIN).toISOString(),
      };
      return memberOpenStarts(m, window).has(startMs);
    })
    .map((m) => m.userId);
}

/**
 * Which members can take EXACTLY this window, judged by the same predicate as
 * `freeMembersForSlot` but without requiring the start to sit on the member's own
 * offering grid (#3248, red team 9).
 *
 * The grid exists only to GENERATE offers. A reroute moves a booking that already
 * has a time, which the lead chose from another advisor's grid, so an advisor whose
 * shift begins at :05 is never offered a :00 start and would be wrongly read as
 * unable to take it. Every other gate (the org's hours, the advisor's hours, the
 * daily cap, the buffers against busy time, and minimum notice as the caller sets
 * it) is the same `bookableSlotReason` call the grid walk makes.
 */
export function freeMembersAtExactWindow(
  members: MemberAvailability[],
  input: Omit<SlotComputeInput, "from" | "to" | "members" | "slotIntervalMin">,
  startMs: number,
): string[] {
  const rules: SlotRules = {
    durationMin: input.durationMin,
    bufferBeforeMin: input.bufferBeforeMin,
    bufferAfterMin: input.bufferAfterMin,
    minNoticeMin: input.minNoticeMin,
    dailyCap: input.dailyCap,
    businessHours: input.businessHours,
  };
  const businessOpen = new Map<number, boolean>();
  return members
    .filter((m) => {
      const dayCounts = m.dayCounts ?? bookingsPerLocalDay(m.bookingStartsMs, m.timezone);
      return isBookableSlotForAgent(m, rules, startMs, input.nowMs, { dayCounts, businessOpen });
    })
    .map((m) => m.userId);
}

const DAY_MS = 24 * 60 * MIN;

/**
 * Widen a [from, to] window by one day on each side, for loading the bookings that
 * feed the DAILY CAP count (#540). The cap is counted per agent per LOCAL day, but
 * the reroute/verify path loads availability for a window only as long as the slot
 * itself — so the per-day count was almost empty and the cap never bit. The full
 * local day containing any instant in [from, to] lies within [from - 24h, to + 24h]
 * for ANY timezone (max UTC offset is under 24h), so widening by a day guarantees
 * the count sees every booking on the slot's day. Only the bookings read uses this;
 * the busy/calendar read keeps the exact window.
 */
export function capCountWindow(fromIso: string, toIso: string): { from: string; to: string } {
  return {
    from: new Date(Date.parse(fromIso) - DAY_MS).toISOString(),
    to: new Date(Date.parse(toIso) + DAY_MS).toISOString(),
  };
}

/**
 * The earliest start the event type's minimum notice allows: a start at or after it may
 * be offered. The one cutoff, read by `filterSlotsFromNow` for the real slots and by the
 * placeholder's start predicate (`bookable-hours.ts`, #4390), so the two cannot disagree.
 */
export function noticeCutoffMs(nowMs: number, minNoticeMin: number): number {
  return nowMs + minNoticeMin * 60_000;
}

/** Drops slot instants earlier than now + min-notice (applied after a cache read). */
export function filterSlotsFromNow(slots: string[], nowMs: number, minNoticeMin: number): string[] {
  const cutoff = noticeCutoffMs(nowMs, minNoticeMin);
  return slots.filter((s) => Date.parse(s) >= cutoff);
}

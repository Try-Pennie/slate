import { DateTime } from "luxon";

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
  /** Confirmed booking start instants (epoch-ms) — for the daily cap. */
  bookingStartsMs: number[];
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
  bookingStarts: { assigned_user_id: string; starts_at: string }[],
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

  const bookingsByUser = new Map<string, number[]>();
  for (const bk of bookingStarts) {
    const list = bookingsByUser.get(bk.assigned_user_id) ?? [];
    list.push(Date.parse(bk.starts_at));
    bookingsByUser.set(bk.assigned_user_id, list);
  }

  return userIds.map((userId) => {
    const schedule = scheduleByUser.get(userId);
    return {
      userId,
      timezone: schedule?.timezone ?? "America/New_York",
      rules: schedule ? (rulesBySchedule.get(schedule.id) ?? []) : [],
      busy: busyByUser.get(userId) ?? [],
      bookingStartsMs: bookingsByUser.get(userId) ?? [],
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
function timeOnDay(day: DateTime, minutes: number): DateTime {
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

/** The per-agent slot rules a single slot is judged against (#536). */
export interface SlotRules {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  dailyCap: number | null;
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
  if (dayKey === null) return true;
  const counts = dayCounts ?? bookingsPerLocalDay(bookingStartsMs, timezone);
  return (counts.get(dayKey) ?? 0) < dailyCap;
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
 * `min_notice` -> `working_hours` -> `daily_cap` -> `buffer` (a busy block inside
 * the buffered window, i.e. a calendar conflict). `null` means bookable.
 */
export type UnbookableReason = "min_notice" | "working_hours" | "daily_cap" | "buffer";

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
  },
): UnbookableReason | null {
  const endMs = startMs + rules.durationMin * MIN;
  if (startMs < nowMs + rules.minNoticeMin * MIN) return "min_notice";
  if (!isWithinWorkingHours(m.rules, m.timezone, startMs, endMs)) return "working_hours";
  if (
    (opts?.enforceDailyCap ?? true) &&
    !isUnderDailyCap(m.bookingStartsMs, m.timezone, startMs, rules.dailyCap, opts?.dayCounts)
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
  },
): boolean {
  return bookableSlotReason(m, rules, startMs, nowMs, opts) === null;
}

/** Open start instants for a single member within the window. */
function memberOpenStarts(
  m: MemberAvailability,
  input: SlotComputeInput,
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
  };

  const rulesByDay = new Map<number, WorkingRule[]>();
  for (const r of m.rules) {
    const list = rulesByDay.get(r.weekday) ?? [];
    list.push(r);
    rulesByDay.set(r.weekday, list);
  }

  // Pre-count bookings per local day once; shared with the cap check below and
  // passed to the predicate so the per-slot daily-cap decision isn't recomputed.
  const dayCounts = bookingsPerLocalDay(m.bookingStartsMs, m.timezone);

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

    if (!capped) {
      for (const rule of rulesByDay.get(day.weekday) ?? []) {
        const windowStart = timeOnDay(day, rule.start_minute);
        const windowEnd = timeOnDay(day, rule.end_minute);

        let slot = windowStart;
        while (slot.plus({ minutes: input.durationMin }) <= windowEnd) {
          const startMs = slot.toMillis();
          const endMs = startMs + durMs;

          const inWindow = startMs >= fromMs && endMs <= toMs;
          if (inWindow && isBookableSlotForAgent(m, rules, startMs, input.nowMs, { dayCounts })) {
            open.add(startMs);
          }
          slot = slot.plus({ milliseconds: stepMs });
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
  for (const m of input.members) {
    for (const ms of memberOpenStarts(m, input)) union.add(ms);
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

/** Drops slot instants earlier than now + min-notice (applied after a cache read). */
export function filterSlotsFromNow(slots: string[], nowMs: number, minNoticeMin: number): string[] {
  const cutoff = nowMs + minNoticeMin * 60_000;
  return slots.filter((s) => Date.parse(s) >= cutoff);
}

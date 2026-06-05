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

function overlaps(
  busy: { start: number; end: number }[],
  start: number,
  end: number,
): boolean {
  for (const b of busy) {
    if (b.start < end && b.end > start) return true;
  }
  return false;
}

/** Open start instants for a single member within the window. */
function memberOpenStarts(
  m: MemberAvailability,
  input: SlotComputeInput,
): Set<number> {
  const open = new Set<number>();
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const earliest = input.nowMs + input.minNoticeMin * MIN;
  const durMs = input.durationMin * MIN;
  const stepMs = input.slotIntervalMin * MIN;

  const rulesByDay = new Map<number, WorkingRule[]>();
  for (const r of m.rules) {
    const list = rulesByDay.get(r.weekday) ?? [];
    list.push(r);
    rulesByDay.set(r.weekday, list);
  }

  // Pre-count bookings per local day for the daily cap.
  const dayCounts = new Map<string, number>();
  if (input.dailyCap !== null) {
    for (const ms of m.bookingStartsMs) {
      const key = DateTime.fromMillis(ms, { zone: m.timezone }).toISODate();
      if (key) dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
    }
  }

  // Iterate local calendar days spanning the window.
  let day = DateTime.fromMillis(fromMs, { zone: m.timezone }).startOf("day");
  const lastDay = DateTime.fromMillis(toMs, { zone: m.timezone }).startOf("day");

  while (day <= lastDay) {
    const dayKey = day.toISODate();
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
          const enoughNotice = startMs >= earliest;
          const free =
            !overlaps(
              m.busy,
              startMs - input.bufferBeforeMin * MIN,
              endMs + input.bufferAfterMin * MIN,
            );

          if (inWindow && enoughNotice && free) open.add(startMs);
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

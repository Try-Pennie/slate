// The slot walk as it stood before #2806, kept as the ORACLE the faster walk in
// src/lib/availability/compute.ts is proved against
// (scripts/test-slot-walk-equivalence.ts). It is deliberately the slow, obvious
// version: every candidate start is stepped with Luxon and judged by
// `bookableSlotReason` with no per day facts handed in, so each slot pays the full
// zone conversion the general predicate does. Its value is being plainly right,
// so do not optimise it; an oracle that shares the optimisation can only agree with
// it (L721).
//
// `faults` re-introduces, one at a time, the plausible mistakes a faster walk could
// make. The suite runs each and requires the generated fixtures to CATCH it, which
// is what proves the fixtures reach a DST day, a cap boundary and an agent whose
// day is not the org's (L1). Production never passes one.
import { DateTime } from "luxon";
import {
  bookableSlotReason,
  type MemberAvailability,
  type SlotComputeInput,
  type SlotRules,
  type WorkingRule,
} from "../../src/lib/availability/compute.ts";

const MIN = 60_000;

export interface WalkFaults {
  /** Shift windows as local midnight plus a DURATION, not a wall clock set. */
  durationAddWindows?: boolean;
  /** The daily cap counted on the instant's UTC date, not the agent's local one. */
  capDayInUtc?: boolean;
  /** The shift judged in the ORG's zone rather than the agent's own. */
  shiftInOrgZone?: boolean;
  /** Skip a slot whose start is exactly the window's last fitting start. */
  dropLastFittingStart?: boolean;
}

/** The pre-#2806 wall clock helper, verbatim. */
function timeOnDay(day: DateTime, minutes: number): DateTime {
  if (minutes >= 1440) return day.plus({ days: 1 }).startOf("day");
  return day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });
}

function bookingsPerLocalDay(bookingStartsMs: number[], timezone: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ms of bookingStartsMs) {
    const key = DateTime.fromMillis(ms, { zone: timezone }).toISODate();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function referenceMemberOpenStarts(
  m: MemberAvailability,
  input: SlotComputeInput,
  businessOpen: Map<number, boolean> | undefined,
  faults: WalkFaults,
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
  const dayCounts = m.dayCounts ?? bookingsPerLocalDay(m.bookingStartsMs, m.timezone);
  const judged = faults.shiftInOrgZone ? { ...m, timezone: input.businessHours.zone } : m;
  const underCapUtc = (startMs: number) =>
    input.dailyCap === null ||
    (dayCounts.get(new Date(startMs).toISOString().slice(0, 10)) ?? 0) < input.dailyCap;

  let day = DateTime.fromMillis(fromMs, { zone: m.timezone }).startOf("day");
  const lastDay = DateTime.fromMillis(toMs, { zone: m.timezone }).startOf("day");
  while (day <= lastDay) {
    const dayKey = day.toISODate();
    const capped =
      input.dailyCap !== null && dayKey !== null && (dayCounts.get(dayKey) ?? 0) >= input.dailyCap;
    if (!capped) {
      for (const rule of rulesByDay.get(day.weekday) ?? []) {
        const windowStart = faults.durationAddWindows
          ? day.plus({ minutes: rule.start_minute })
          : timeOnDay(day, rule.start_minute);
        const windowEnd = faults.durationAddWindows
          ? day.plus({ minutes: rule.end_minute })
          : timeOnDay(day, rule.end_minute);
        let slot = windowStart;
        while (slot.plus({ minutes: input.durationMin }) <= windowEnd) {
          const startMs = slot.toMillis();
          const endMs = startMs + durMs;
          const isLast = !(slot.plus({ minutes: input.durationMin + input.slotIntervalMin }) <= windowEnd);
          const inWindow = startMs >= fromMs && endMs <= toMs;
          if (
            inWindow &&
            !(faults.dropLastFittingStart && isLast) &&
            (!faults.capDayInUtc || underCapUtc(startMs)) &&
            bookableSlotReason(judged, rules, startMs, input.nowMs, {
              dayCounts,
              businessOpen,
              enforceDailyCap: !faults.capDayInUtc,
            }) === null
          ) {
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

/** The pre-#2806 `computeBucketSlots`. */
export function referenceBucketSlots(input: SlotComputeInput, faults: WalkFaults = {}): string[] {
  const union = new Set<number>();
  const businessOpen = new Map<number, boolean>();
  for (const m of input.members) {
    for (const ms of referenceMemberOpenStarts(m, input, businessOpen, faults)) union.add(ms);
  }
  return [...union].sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
}

/** The pre-#2806 `freeMembersForSlot`. */
export function referenceFreeMembersForSlot(
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
      return referenceMemberOpenStarts(m, window, undefined, {}).has(startMs);
    })
    .map((m) => m.userId);
}

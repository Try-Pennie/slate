/**
 * Why a debt tier has no times inside the window (#3037).
 *
 * The tier alarm used to end on three possible causes, "their calendars are
 * full, their working hours do not reach the window, or their calendar sync has
 * stopped", and leave the reader to find out which. On 2026-10-02 the Ultra High
 * page listed all three while the data already said: sync was healthy for all
 * ten agents, every one of them was booked or off for the rest of Friday, and
 * Saturday (an open business day) had one agent working, fully booked.
 *
 * So this works the cause out per agent, per open day of the window:
 *
 *  - SYNC STOPPED, for the whole window: a calendar whose sync has failed in a
 *    way retrying cannot fix (`isDefinitiveFailure`, never a literal comparison
 *    against "gone"), or that has not synced cleanly inside the same threshold
 *    the staleness page uses. Their busy times cannot be trusted, so they are
 *    reported apart rather than counted as booked or free.
 *  - OFF, for one day: no instant of that day passes the agent's own working
 *    hours, judged in the agent's OWN zone.
 *  - BOOKED with Slate calls, or HELD by other meetings or time off: the agent
 *    works that day and every instant is refused by a calendar conflict or the
 *    daily cap. Split by whether the conflict is a Slate booking.
 *  - OPEN: an instant passes. The cached times disagree with a fresh check, so
 *    the honest cause is that the cache is behind, and it is said as that rather
 *    than folded into one of the others.
 *
 * Every instant is judged by `bookableSlotReason`, the same predicate the booker
 * offers times with, so this cannot call an agent free or busy by a rule the
 * booker does not apply. The instants are generated the way the slot compute
 * generates them: from each of the agent's working windows, in their own zone,
 * on the event type's interval.
 *
 * Pure. The reads belong to the monitor lane, which runs them only on a tick that
 * is about to page, and which falls back to the old wording when any of them
 * fails rather than guessing a cause (L215, L11).
 */
import { DateTime } from "luxon";
import {
  bookableSlotReason,
  type BusinessHoursRules,
  type SlotRules,
  type WorkingRule,
} from "../availability/compute.ts";
import { windowOnDate } from "../booking/business-hours.ts";
import { parseStampMs } from "../date/stamp.ts";
import { isDefinitiveFailure, type FailureKind } from "../google/sync-health.ts";
import { SYNC_STALENESS_THRESHOLD_MS } from "./sync-staleness.ts";
import { tierNoSlotsMessage } from "./tier-staffing.ts";

const MIN = 60_000;

/** `minutes` after local midnight on `day`, by the wall clock rather than an added
 *  duration, so a DST transition day does not shift the window. 1440 is the next
 *  midnight. */
function wallClock(day: DateTime, minutes: number): number {
  if (minutes >= 1440) return day.plus({ days: 1 }).startOf("day").toMillis();
  return day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 }).toMillis();
}

/** The sync health of one of an agent's calendars, as `agent_calendars` holds it. */
export interface CauseCalendar {
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_kind: FailureKind | null;
}

/** One busy interval, and whether it is a Slate booking (as against an outside
 *  meeting, or an approved time off block, which is a Slate row with no booking). */
export interface CauseBusy {
  start: number;
  end: number;
  slateBooking: boolean;
}

export interface CauseAgent {
  id: string;
  /** The agent's OWN zone. Their hours are judged in it, never in the org's. */
  timezone: string;
  rules: WorkingRule[];
  calendars: CauseCalendar[];
  busy: CauseBusy[];
}

export interface TierCauseInput {
  agents: CauseAgent[];
  /** The tier pool's event type rules plus the org's week, as the booker uses them. */
  slot: SlotRules;
  slotIntervalMin: number;
  businessHours: BusinessHoursRules;
  nowMs: number;
  windowEndMs: number;
}

/** One open business day of the window, with every agent whose sync runs counted
 *  in exactly one of the four columns. */
export interface DayTally {
  /** The org's local date, `2026-10-03`. */
  isoDate: string;
  /** How the day is named in a sentence: "the rest of today", or a weekday. */
  label: string;
  off: number;
  slate: number;
  outside: number;
  open: number;
}

export interface TierCause {
  /** Agents on the tier. */
  total: number;
  /** Agents whose calendar sync has stopped; left out of every day tally. */
  syncStopped: number;
  days: DayTally[];
}

/**
 * The diagnosis, and whether it was measured, as one value (L544). An unread
 * cause is not "no cause": the copy falls back to the three possibilities and
 * says it could not tell which.
 */
export type TierCauseReading = { measured: false } | { measured: true; cause: TierCause };

/**
 * Has this agent's calendar sync stopped?
 *
 * Any one calendar stopping is enough, because one unread calendar is enough to
 * make the agent's busy times untrustworthy. No calendar at all reads as stopped:
 * nothing about their diary can be read. An unreadable success stamp reads as
 * stopped, never as fresh (#1169's direction).
 */
export function isCalendarSyncStopped(calendars: CauseCalendar[], nowMs: number): boolean {
  if (calendars.length === 0) return true;
  return calendars.some((c) => {
    if (c.consecutive_failures > 0 && isDefinitiveFailure(c.last_failure_kind)) return true;
    const success = parseStampMs(c.last_success_at);
    return success === null || nowMs - success > SYNC_STALENESS_THRESHOLD_MS;
  });
}

/**
 * The org's open days inside the window, each with how it is named.
 *
 * A day counts only if a call can still start in it: today after the close, or
 * inside the minimum notice of it, is not a day anybody could have been offered.
 */
function openDays(input: TierCauseInput): { isoDate: string; label: string }[] {
  const zone = input.businessHours.zone;
  const today = DateTime.fromMillis(input.nowMs, { zone }).startOf("day");
  const lastDay = DateTime.fromMillis(input.windowEndMs, { zone }).startOf("day");
  const earliestStart = input.nowMs + input.slot.minNoticeMin * MIN;
  const days: { isoDate: string; label: string }[] = [];
  for (let day = today; day <= lastDay; day = day.plus({ days: 1 })) {
    const isoDate = day.toISODate();
    if (isoDate === null) continue;
    const window = windowOnDate(input.businessHours, isoDate, day.weekday);
    if (!window) continue;
    const open = wallClock(day, window.start_minute);
    const close = Math.min(wallClock(day, window.end_minute), input.windowEndMs);
    if (Math.max(open, earliestStart) + input.slot.durationMin * MIN > close) continue;
    const label = day.hasSame(today, "day") ? "the rest of today" : day.toFormat("cccc");
    days.push({ isoDate, label });
  }
  return days;
}

type DayState = "off" | "slate" | "outside" | "open";

/** What one agent's day comes to, from the reasons its instants were refused. */
function agentDayStates(
  agent: CauseAgent,
  input: TierCauseInput,
  dayIsos: Set<string>,
): Map<string, DayState> {
  const { slot, nowMs, windowEndMs } = input;
  const orgZone = input.businessHours.zone;
  const durMs = slot.durationMin * MIN;
  const stepMs = Math.max(1, input.slotIntervalMin) * MIN;
  // The daily cap counts Slate bookings per the agent's local day; the booking
  // blocks are the bookings, so they are what is counted.
  const bookingStartsMs = agent.busy.filter((b) => b.slateBooking).map((b) => b.start);
  const member = { timezone: agent.timezone, rules: agent.rules, busy: agent.busy, bookingStartsMs };
  const tally = new Map<string, { open: number; slate: number; outside: number }>();

  let day = DateTime.fromMillis(nowMs, { zone: agent.timezone }).startOf("day");
  const lastDay = DateTime.fromMillis(windowEndMs, { zone: agent.timezone }).startOf("day");
  for (; day <= lastDay; day = day.plus({ days: 1 })) {
    for (const rule of agent.rules) {
      if (rule.weekday !== day.weekday) continue;
      // Wall clock on the agent's own day, as the slot compute steps it.
      const windowStart = wallClock(day, rule.start_minute);
      const windowEnd = wallClock(day, rule.end_minute);
      for (let startMs = windowStart; startMs + durMs <= windowEnd; startMs += stepMs) {
        if (startMs < nowMs || startMs > windowEndMs) continue;
        const reason = bookableSlotReason(member, slot, startMs, nowMs);
        // Notice, the org being shut, and off shift are not the agent being busy:
        // an instant nobody could have been offered says nothing about them.
        if (reason === "min_notice" || reason === "business_hours" || reason === "working_hours") continue;
        const isoDate = DateTime.fromMillis(startMs, { zone: orgZone }).toISODate();
        if (isoDate === null || !dayIsos.has(isoDate)) continue;
        const t = tally.get(isoDate) ?? { open: 0, slate: 0, outside: 0 };
        if (reason === null) t.open++;
        else if (reason === "daily_cap") t.slate++;
        else {
          const from = startMs - slot.bufferBeforeMin * MIN;
          const to = startMs + durMs + slot.bufferAfterMin * MIN;
          const slateConflict = agent.busy.some((b) => b.slateBooking && b.start < to && b.end > from);
          if (slateConflict) t.slate++;
          else t.outside++;
        }
        tally.set(isoDate, t);
      }
    }
  }

  const states = new Map<string, DayState>();
  for (const iso of dayIsos) {
    const t = tally.get(iso);
    if (!t) states.set(iso, "off");
    else if (t.open > 0) states.set(iso, "open");
    // A day split between the two is named by whichever held more of it.
    else states.set(iso, t.slate >= t.outside ? "slate" : "outside");
  }
  return states;
}

/** Work out the cause for a tier, per agent and per open day of the window. */
export function diagnoseTierCause(input: TierCauseInput): TierCause {
  const days = openDays(input);
  const dayIsos = new Set(days.map((d) => d.isoDate));
  const tallies: DayTally[] = days.map((d) => ({ ...d, off: 0, slate: 0, outside: 0, open: 0 }));
  let syncStopped = 0;
  for (const agent of input.agents) {
    if (isCalendarSyncStopped(agent.calendars, input.nowMs)) {
      syncStopped++;
      continue;
    }
    const states = agentDayStates(agent, input, dayIsos);
    for (const t of tallies) t[states.get(t.isoDate) ?? "off"]++;
  }
  return { total: input.agents.length, syncStopped, days: tallies };
}

/**
 * Assemble each agent from the lane's reads.
 *
 * A busy row whose bounds cannot be read blocks the WHOLE window rather than
 * being dropped: dropping it would read as free time, which is the direction that
 * names the wrong cause (#1171's rule for busy intervals).
 */
export function tierCauseAgents(input: {
  agentIds: string[];
  shiftFor: (userId: string) => { timezone: string; rules: WorkingRule[] };
  calendars: (CauseCalendar & { user_id: string })[];
  busy: { user_id: string; starts_at: string; ends_at: string; booking_id: string | null }[];
}): CauseAgent[] {
  const calendarsBy = new Map<string, CauseCalendar[]>();
  for (const c of input.calendars) {
    const list = calendarsBy.get(c.user_id) ?? [];
    list.push({
      consecutive_failures: c.consecutive_failures,
      last_success_at: c.last_success_at,
      last_failure_kind: c.last_failure_kind,
    });
    calendarsBy.set(c.user_id, list);
  }
  const busyBy = new Map<string, CauseBusy[]>();
  for (const b of input.busy) {
    const start = parseStampMs(b.starts_at);
    const end = parseStampMs(b.ends_at);
    const readable = start !== null && end !== null && end > start;
    const list = busyBy.get(b.user_id) ?? [];
    list.push({
      start: readable ? start : Number.MIN_SAFE_INTEGER,
      end: readable ? end : Number.MAX_SAFE_INTEGER,
      slateBooking: b.booking_id !== null,
    });
    busyBy.set(b.user_id, list);
  }
  return input.agentIds.map((id) => {
    const shift = input.shiftFor(id);
    return {
      id,
      timezone: shift.timezone,
      rules: shift.rules,
      calendars: calendarsBy.get(id) ?? [],
      busy: busyBy.get(id) ?? [],
    };
  });
}

/**
 * The text of one tier's no-slots page, or null when the page is not due.
 *
 * The order is the whole point. The cooldown is asked FIRST, so the diagnostic
 * reads run only on a tick whose page will actually go out: they cost subrequests
 * on a budget four cron lanes share, and a page inside its cooldown would be built
 * and then dropped. Then the cause is read, and any failure on the way (a read, a
 * missing input) becomes `measured: false`, which keeps the old wording plus a
 * clause saying the cause could not be read. A failed diagnosis must never cost
 * the page itself (L215, L11), so nothing in the diagnosis can throw past here.
 */
export async function tierNoSlotsPageText(
  page: { tier: string; label: string; agents: number; firstSlotMs: number | null },
  deps: {
    isDue: () => Promise<boolean>;
    loadCauseInput: () => Promise<TierCauseInput>;
    onCauseError: (err: unknown) => void;
  },
): Promise<string | null> {
  if (!(await deps.isDue())) return null;
  let cause: TierCauseReading;
  try {
    cause = { measured: true, cause: diagnoseTierCause(await deps.loadCauseInput()) };
  } catch (err) {
    deps.onCauseError(err);
    cause = { measured: false };
  }
  return tierNoSlotsMessage(page, cause);
}

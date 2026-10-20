/**
 * Team capacity history (#3940, docs/design/team-capacity.html requirement 15): each advisor's calls
 * saved as they pass, so a past day on the page shows how it ended.
 *
 * Nothing Slate holds can rebuild a past day later: working hours are kept only as they are now,
 * and past busy time is pruned after BUSY_PRUNE_KEEP_PAST_HOURS. So a lane runs every half hour and
 * saves, per advisor and day, the day's shift, time off and capacity, and every call that was still
 * open at the moment it could no longer be booked. A call with its gap is half an hour, so each
 * saved call is one half hour that went unused; the rest of the shift was booked or off.
 *
 * ## The same calculation as a coming day (L107)
 *
 * Every number comes from `advisorDay` and `openStartsAt`, the booker's own slot rules. A call is
 * judged at the tick after it stopped being bookable (its start minus the notice), against the
 * calendar as it is then, so a call booked before that point is taken and a calendar edited later
 * never rewrites it.
 *
 * ## A tick at a time adds up to the whole day
 *
 * Calls are packed earliest first, and packing carries on from the last call already saved that
 * day, so recording a day in half hour pieces saves exactly what packing it at once would.
 * scripts/test-capacity-history.ts holds that at several cadences and across a five hour gap.
 *
 * Pure (luxon and the pure slot core), so the test drives it node natively.
 */
import { DateTime } from "luxon";
import type { BusinessHoursRules, MemberAvailability } from "../availability/compute.ts";
import type { CapacityPeople, CapacityRead } from "./team-capacity-load.ts";
import { BUSY_PRUNE_KEEP_PAST_HOURS } from "../busy/prune-core.ts";
import {
  advisorDay,
  bookedOnDay,
  callsThatFit,
  openStartsAt,
  type CapacityEventType,
  type TeamCapacityAdvisor,
  type TimeOffInterval,
} from "./team-capacity.ts";

/**
 * The picker asks for every saved day, so the earliest it is handed is always history's real first
 * day, the partly recorded one it leaves out. One array of dates, a few hundred a year.
 */
export const EVERY_SAVED_DAY_FROM = "1970-01-01";

/**
 * How far back a tick catches up after the lane was down. A day, well inside the 36 hours past busy
 * time is kept: further back, a pruned call would read as open time, so that stretch is skipped and
 * said rather than saved wrong. The lane's heartbeat pages long before this is reached.
 */
export const HISTORY_MAX_CATCH_UP_MS = 24 * 3_600_000;
if (HISTORY_MAX_CATCH_UP_MS >= BUSY_PRUNE_KEEP_PAST_HOURS * 3_600_000) {
  throw new Error("history catch up reaches past the busy time the prune keeps");
}

/** The stretch of the clock a tick covers: calls that stopped being bookable within it are saved. */
export interface HistoryWindow {
  fromMs: number;
  toMs: number;
  /** Clock skipped because the lane was down longer than it may catch up. */
  skippedMs: number;
}

/** What one tick covers, from where the last one stopped. A first run starts now and saves nothing. */
export function historyWindow(cursorMs: number | null, nowMs: number): HistoryWindow {
  if (cursorMs === null) return { fromMs: nowMs, toMs: nowMs, skippedMs: 0 };
  const from = Math.min(cursorMs, nowMs);
  const earliest = nowMs - HISTORY_MAX_CATCH_UP_MS;
  if (from < earliest) return { fromMs: earliest, toMs: nowMs, skippedMs: earliest - from };
  return { fromMs: from, toMs: nowMs, skippedMs: 0 };
}

/** The office days whose calls stop being bookable within the window. */
export function historyDays(window: HistoryWindow, eventType: Pick<CapacityEventType, "min_notice_min">, zone: string): string[] {
  if (window.toMs <= window.fromMs) return [];
  const notice = eventType.min_notice_min * 60_000;
  let day = DateTime.fromMillis(window.fromMs + notice, { zone }).startOf("day");
  const last = DateTime.fromMillis(window.toMs + notice - 1, { zone }).startOf("day");
  const days: string[] = [];
  while (day <= last) {
    days.push(day.toISODate()!);
    day = day.plus({ days: 1 });
  }
  return days;
}

/** One advisor's day as saved: one row of capacity_history. Times are ISO instants. */
export interface HistoryRow {
  user_id: string;
  day: string;
  timezone: string;
  /** Calls the whole shift could hold, approved time off taken out. */
  capacity: number;
  /** The calls saved in this tick, still open when they could no longer be booked. */
  open_times: string[];
  is_out: boolean;
  no_shift: boolean;
  /** The calendar was not syncing at a tick, so the day's room cannot be trusted. Sticky. */
  unsynced: boolean;
  shift_start: string | null;
  shift_end: string | null;
  time_off: { start: string; end: string }[];
}

export function historyKey(userId: string, day: string): string {
  return `${userId}|${day}`;
}

export interface HistoryRowsInput {
  window: HistoryWindow;
  days: string[];
  hours: BusinessHoursRules;
  eventType: CapacityEventType;
  roster: { id: string; name: string | null; email: string }[];
  members: MemberAvailability[];
  timeOff: Map<string, TimeOffInterval[]>;
  failingEmails: Set<string>;
  /** The calls already saved, by `historyKey`, so packing carries on after them. */
  existing: Map<string, string[]>;
}

/** One row per advisor and day the window touches, holding the calls that passed in it. */
export function historyRows(input: HistoryRowsInput): HistoryRow[] {
  const { window, eventType, hours } = input;
  const byId = new Map(input.members.map((m) => [m.userId, m]));
  const notice = eventType.min_notice_min * 60_000;
  const lo = window.fromMs + notice;
  const hi = window.toMs + notice;
  const rows: HistoryRow[] = [];
  for (const u of input.roster) {
    // A missing row is an incomplete read, never an advisor with nothing to save (see teamCapacityReport).
    const member = byId.get(u.id);
    if (!member) throw new Error(`the availability read returned no row for advisor ${u.id}`);
    const timeOff = input.timeOff.get(u.id) ?? [];
    for (const iso of input.days) {
      const day = DateTime.fromISO(iso, { zone: hours.zone }).startOf("day");
      const base = { member, timeOff, day, eventType, hours };
      // The day as it looked before it began: its whole shift, time off and capacity.
      const whole = advisorDay({ ...base, nowMs: day.minus({ days: 1 }).toMillis() });
      const passed = openStartsAt({ ...base, nowMs: window.fromMs }).filter((s) => {
        const ms = Date.parse(s);
        return ms >= lo && ms < hi;
      });
      const saved = input.existing.get(historyKey(u.id, iso)) ?? [];
      const lastMs = saved.length ? Math.max(...saved.map((s) => Date.parse(s))) : null;
      let open = callsThatFit(passed, eventType, lastMs);
      if (eventType.daily_cap !== null) open = open.slice(0, Math.max(0, eventType.daily_cap - bookedOnDay(member, day) - saved.length));
      rows.push({
        user_id: u.id,
        day: iso,
        timezone: member.timezone,
        capacity: whole.capacity,
        open_times: open,
        is_out: whole.out,
        no_shift: whole.noShift,
        unsynced: input.failingEmails.has(u.email),
        shift_start: whole.fullShiftStart,
        shift_end: whole.fullShiftEnd,
        time_off: whole.timeOff,
      });
    }
  }
  return rows;
}

/**
 * A saved day read back as the page's advisor, so a past day is drawn and totalled by the same code
 * as a coming one. `open_times` here is everything saved for the day.
 */
export function historyAdvisor(row: HistoryRow & { name: string | null; email: string }): TeamCapacityAdvisor {
  // The database spells instants its own way ("+00:00"); the page compares and draws ISO ones.
  const iso = (t: string) => {
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) throw new Error(`capacity history holds an unreadable time: "${t}"`);
    return new Date(ms).toISOString();
  };
  const isoOrNull = (t: string | null) => (t === null ? null : iso(t));
  row = {
    ...row,
    open_times: row.open_times.map(iso).sort(),
    shift_start: isoOrNull(row.shift_start),
    shift_end: isoOrNull(row.shift_end),
    time_off: row.time_off.map((t) => ({ start: iso(t.start), end: iso(t.end) })),
  };
  return {
    id: row.user_id,
    name: row.name ?? row.email,
    email: row.email,
    timezone: row.timezone,
    unsynced: row.unsynced,
    days: [
      {
        iso: row.day,
        open: row.open_times.length,
        capacity: row.capacity,
        out: row.is_out,
        noShift: row.no_shift,
        openTimes: row.open_times,
        // The day as it was lived: nothing of a past shift remains, so the whole one is drawn.
        shiftStart: row.shift_start,
        shiftEnd: row.shift_end,
        fullShiftStart: row.shift_start,
        fullShiftEnd: row.shift_end,
        timeOff: row.time_off,
      },
    ],
  };
}

/** The rules a tick lays calls out by. */
export interface HistoryRules {
  hours: BusinessHoursRules;
  eventType: CapacityEventType;
}

/** A tick's reads and its one write, injected so the order and the refusals are tested here. */
export interface HistoryTickDeps<R extends HistoryRules = HistoryRules> {
  nowMs: number;
  /** Where the last tick stopped, or null before the first. */
  readCursor(): Promise<number | null>;
  loadRules(): Promise<CapacityRead<R>>;
  loadPeople(rules: R, days: string[]): Promise<CapacityRead<CapacityPeople>>;
  /** The calls already saved for these days, by `historyKey`. Throws rather than answering empty. */
  readSaved(days: string[]): Promise<Map<string, string[]>>;
  /** The rows and the cursor, in one transaction. Returns the rows written. */
  write(rows: HistoryRow[], throughMs: number): Promise<number>;
}

export interface HistoryTickResult {
  days: string[];
  rows: number;
  /** Calls saved as open in this tick. */
  open: number;
  skippedMs: number;
  nobodyBookable: boolean;
}

/**
 * One tick. A read that fails throws and writes nothing, so the cursor stays where it was and the
 * next tick covers the stretch; an empty answer is never saved as a day with nobody in it (L10).
 */
export async function runHistoryTick<R extends HistoryRules>(deps: HistoryTickDeps<R>): Promise<HistoryTickResult> {
  const cursor = await deps.readCursor();
  const window = historyWindow(cursor, deps.nowMs);
  const rules = await deps.loadRules();
  if (!rules.ok) throw new Error(`capacity history could not read ${rules.reason}`, { cause: rules.err });
  const days = historyDays(window, rules.value.eventType, rules.value.hours.zone);
  const done = async (rows: HistoryRow[], nobodyBookable = false): Promise<HistoryTickResult> => ({
    days,
    rows: await deps.write(rows, window.toMs),
    open: rows.reduce((n, r) => n + r.open_times.length, 0),
    skippedMs: window.skippedMs,
    nobodyBookable,
  });
  if (days.length === 0) return done([]);
  const people = await deps.loadPeople(rules.value, days);
  if (!people.ok) {
    // Nobody bookable is a state, not a failed read: there is nothing to save and the clock moves on.
    if (people.reason === "no-advisors") return done([], true);
    throw new Error(`capacity history could not read ${people.reason}`, { cause: people.err });
  }
  const existing = await deps.readSaved(days);
  return done(historyRows({ window, days, hours: rules.value.hours, eventType: rules.value.eventType, existing, ...people.value }));
}

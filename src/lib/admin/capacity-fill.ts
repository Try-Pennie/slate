/**
 * Booking pace on Team capacity (#4102): every half hour, a reading of each page day's calls open
 * and how many were taken since the last reading, so the pace a day fills at can be worked out
 * (#4103) from what really happened rather than guessed.
 *
 * ## Measured at the EARLIER instant
 *
 * A run reads at `readAt`, the half hour it falls in. For each page day it saves the counted team's
 * calls open (`dayTotals`) and a snapshot of every counted advisor: open, capacity and a fingerprint
 * of where the capacity's calls start, all from `advisorDay` at nowMs = readAt.
 *
 * The next run evaluates the CURRENT calendar at the PREVIOUS reading's instant for each advisor in
 * that snapshot. Taken is the snapshot's open minus that. Same instant, same packing start, so time
 * passing cancels, and a booking for the very next times still counts: compared at the later
 * instant, those calls have already passed and the booking is invisible (264 of 1,091 bookings over
 * 14 days started within 35 minutes of being made, about a fifth of same day bookings).
 *
 * ## Comparable advisors, and an unknown that is never 0
 *
 * An advisor is comparable when their calendar still syncs, they are still in the pool, and the
 * capacity fingerprint at the earlier instant is unchanged, so hours, time off and office hours are
 * as they were. The comparable share is their capacity over the whole counted team's. Under
 * `COMPARABLE_SHARE_FLOOR` taken is null with its reason, never 0: an office hours edit, a Google
 * outage or a bulk time off approval makes everyone non comparable, and 0 would read as a day
 * nobody booked. Above it, taken is scaled from the comparable advisors to the counted team.
 *
 * Every number comes from `advisorDay`, `capacityStarts` and `dayTotals`, the page's own rules (L107).
 *
 * Pure (luxon and the pure slot core), so scripts/test-capacity-fill.ts drives it node natively.
 */
import { DateTime } from "luxon";
import type { BusinessHoursRules } from "../availability/compute.ts";
import { BUSY_PRUNE_KEEP_PAST_HOURS } from "../busy/prune-core.ts";
import { cyrb53 } from "../cyrb53.ts";
import { capacityDays } from "./capacity-days.ts";
import type { CapacityPeople, CapacityRead } from "./team-capacity-load.ts";
import { advisorDay, capacityStarts, dayTotals, type AdvisorDayInput, type CapacityEventType } from "./team-capacity.ts";

/** A reading every half hour, stamped at the half hour the run falls in. */
export const FILL_SLOT_MS = 30 * 60_000;

/**
 * The comparable share under which taken is unknown. 80% to start; recalibrate from the first week
 * of real readings (#4102).
 */
export const COMPARABLE_SHARE_FLOOR = 0.8;

/**
 * The longest interval a late run still measures. The earlier instant's calendar is read from busy
 * time as it is now, and past busy time is pruned after BUSY_PRUNE_KEEP_PAST_HOURS, so further back a
 * pruned call would read as given back.
 */
export const FILL_MAX_INTERVAL_MS = 24 * 3_600_000;
if (FILL_MAX_INTERVAL_MS >= BUSY_PRUNE_KEEP_PAST_HOURS * 3_600_000) {
  throw new Error("a capacity fill interval reaches past the busy time the prune keeps");
}

/** The half hour a run at `nowMs` reads at. */
export function fillReadAt(nowMs: number): number {
  return Math.floor(nowMs / FILL_SLOT_MS) * FILL_SLOT_MS;
}

/**
 * The half hour of the office's day (0 to 47) and its weekday (Luxon, 1 = Monday) at `readAtMs`.
 * The one place either is worked out, so no zone arithmetic happens anywhere else, SQL included.
 * On the night the clocks go back an hour repeats, and both of its readings share a half hour.
 */
export function officeSlot(readAtMs: number, zone: string): { slotOfDay: number; weekday: number } {
  const local = DateTime.fromMillis(readAtMs, { zone });
  return { slotOfDay: Math.floor((local.hour * 60 + local.minute) / 30), weekday: local.weekday };
}

/**
 * A short fingerprint of where the capacity's calls start (cyrb53), so a change to hours or time off
 * is seen even when the count comes out the same, without storing every start.
 */
export function capacityFingerprint(starts: string[]): string {
  // Seeded with the count, so an empty day and a day of one call never share a name.
  return cyrb53(starts.join(","), starts.length);
}

/** One counted advisor as a reading saw them: what the next reading compares with. */
export interface FillSnapshotEntry {
  open: number;
  capacity: number;
  fp: string;
}
/** Every counted advisor on one day, by user id. Uncounted advisors (not syncing, out) are left out. */
export type FillSnapshot = Record<string, FillSnapshotEntry>;

/** The last snapshot saved for a day, and the half hour it was read at. */
export interface FillLast {
  readAtMs: number;
  snapshot: FillSnapshot;
}

/** Why taken is unknown on a reading. */
export type TakenReason =
  /** No earlier reading of this day: the first run, or a day newly in the window. */
  | "first-reading"
  /** The earlier reading is more than FILL_MAX_INTERVAL_MS back. */
  | "too-long-since"
  /** Under COMPARABLE_SHARE_FLOOR of the counted capacity could be compared. */
  | "too-few-comparable"
  /** The counted team had no capacity left at the earlier reading, so nothing could be taken. */
  | "no-capacity";

/** One row of capacity_fill_readings, less the org and read_at the write supplies. */
export interface FillReadingRow {
  day: string;
  /** The day's index among the booker's days, null for a page day the booker no longer offers. */
  day_position: number | null;
  slot_of_day: number;
  weekday: number;
  /** The earlier reading this one was compared with, as an ISO instant, or null for none. */
  prev_read_at: string | null;
  /** Calls taken since `prev_read_at`, scaled to the counted team; null with `taken_reason`. */
  taken: number | null;
  taken_reason: TakenReason | null;
  /** The counted team's calls open and capacity at this reading, as the page totals them. */
  open: number;
  capacity: number;
  /** Comparable capacity over counted capacity at the earlier reading; null with no earlier one. */
  comparable_share: number | null;
  excluded_not_syncing: number;
  excluded_left_pool: number;
  excluded_capacity_changed: number;
}

export interface FillReadingsInput {
  readAtMs: number;
  /** The page's days (`capacityDays().windowDays`): every one is read. */
  windowDays: string[];
  /** The booker's days (`capacityDays().bookerDays`), for each day's position. */
  bookerDays: string[];
  hours: BusinessHoursRules;
  eventType: CapacityEventType;
  people: CapacityPeople;
  /** Each day's last snapshot, where one was saved. */
  last: Map<string, FillLast>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One reading per page day, and the snapshots the next run compares with. */
export function fillReadings(input: FillReadingsInput): { rows: FillReadingRow[]; last: { day: string; snapshot: FillSnapshot }[] } {
  const { readAtMs, hours, eventType, people } = input;
  const byId = new Map(people.members.map((m) => [m.userId, m]));
  const roster = new Map(people.roster.map((u) => [u.id, u]));
  for (const u of people.roster) {
    // A missing row is an incomplete read, never an advisor with no room (see teamCapacityReport).
    if (!byId.has(u.id)) throw new Error(`the availability read returned no row for advisor ${u.id}`);
  }
  const { slotOfDay, weekday } = officeSlot(readAtMs, hours.zone);
  const rows: FillReadingRow[] = [];
  const last: { day: string; snapshot: FillSnapshot }[] = [];

  for (const iso of input.windowDays) {
    const day = DateTime.fromISO(iso, { zone: hours.zone }).startOf("day");
    const at = (userId: string, nowMs: number): AdvisorDayInput => ({
      member: byId.get(userId)!,
      timeOff: people.timeOff.get(userId) ?? [],
      day,
      eventType,
      hours,
      nowMs,
    });

    // This reading: the page's totals, and a snapshot of every counted advisor.
    const snapshot: FillSnapshot = {};
    const advisors = people.roster.map((u) => {
      const input = at(u.id, readAtMs);
      const d = advisorDay(input);
      const unsynced = people.failingEmails.has(u.email);
      if (!unsynced && !d.out) snapshot[u.id] = { open: d.open, capacity: d.capacity, fp: capacityFingerprint(capacityStarts(input)) };
      return { unsynced, days: [d] };
    });
    const totals = dayTotals(advisors, 0);
    last.push({ day: iso, snapshot });

    const position = input.bookerDays.indexOf(iso);
    const base = {
      day: iso,
      day_position: position === -1 ? null : position,
      slot_of_day: slotOfDay,
      weekday,
      open: totals.open,
      capacity: totals.capacity,
      excluded_not_syncing: 0,
      excluded_left_pool: 0,
      excluded_capacity_changed: 0,
    };
    const prev = input.last.get(iso);
    if (prev && prev.readAtMs >= readAtMs) throw new Error(`the last reading of ${iso} is not earlier than this one`);
    if (!prev) {
      rows.push({ ...base, prev_read_at: null, taken: null, taken_reason: "first-reading", comparable_share: null });
      continue;
    }
    const prevIso = new Date(prev.readAtMs).toISOString();
    if (readAtMs - prev.readAtMs > FILL_MAX_INTERVAL_MS) {
      rows.push({ ...base, prev_read_at: prevIso, taken: null, taken_reason: "too-long-since", comparable_share: null });
      continue;
    }

    // The earlier reading's advisors, judged at its instant against the calendar as it is now.
    let countedCapacity = 0, comparableCapacity = 0, comparableTaken = 0;
    for (const [userId, was] of Object.entries(prev.snapshot)) {
      countedCapacity += was.capacity;
      const u = roster.get(userId);
      if (!u) { base.excluded_left_pool++; continue; }
      if (people.failingEmails.has(u.email)) { base.excluded_not_syncing++; continue; }
      const input = at(userId, prev.readAtMs);
      if (capacityFingerprint(capacityStarts(input)) !== was.fp) { base.excluded_capacity_changed++; continue; }
      comparableCapacity += was.capacity;
      comparableTaken += was.open - advisorDay(input).open;
    }
    if (countedCapacity === 0) {
      rows.push({ ...base, prev_read_at: prevIso, taken: null, taken_reason: "no-capacity", comparable_share: null });
      continue;
    }
    const share = comparableCapacity / countedCapacity;
    const measured = share >= COMPARABLE_SHARE_FLOOR;
    rows.push({
      ...base,
      prev_read_at: prevIso,
      taken: measured ? round2((comparableTaken * countedCapacity) / comparableCapacity) : null,
      taken_reason: measured ? null : "too-few-comparable",
      comparable_share: Math.round(share * 10_000) / 10_000,
    });
  }
  return { rows, last };
}

/** The rules a run lays calls out by. */
export interface FillRules {
  hours: BusinessHoursRules;
  eventType: CapacityEventType;
}

/** One run's write: readings for its half hour, and the snapshots moved on from `prevReadAtMs`. */
export interface FillWrite {
  readAtMs: number;
  /** The org's latest snapshot when the run read, or null before the first. */
  prevReadAtMs: number | null;
  rows: FillReadingRow[];
  last: { day: string; snapshot: FillSnapshot }[];
}

/** A run's reads and its one write, injected so the order and the refusals are tested here. */
export interface FillTickDeps<R extends FillRules = FillRules> {
  nowMs: number;
  loadRules(): Promise<CapacityRead<R>>;
  /** The booker's open days setting; null when it cannot be read. */
  readOfferedDays(): Promise<number | null>;
  /** The org's latest snapshot instant, and the last snapshot of each of `days`. Throws rather than answering empty. */
  readLast(days: string[]): Promise<{ latestReadAtMs: number | null; byDay: Map<string, FillLast> }>;
  loadPeople(rules: R, days: string[]): Promise<CapacityRead<CapacityPeople>>;
  /** Returns whether it wrote: false when another run has already moved the snapshots on. */
  write(w: FillWrite): Promise<boolean>;
}

export interface FillTickResult {
  readAtMs: number;
  days: string[];
  /** What the run found: recorded, or why it wrote nothing without failing. */
  state: "recorded" | "already-recorded" | "no-open-days" | "no-advisors" | "lost-race";
  wrote: boolean;
  rows: number;
  /** Readings whose taken was measured. */
  measured: number;
}

/**
 * One run for one org. A read that fails throws and writes nothing, so the snapshots stay and the
 * next run measures the longer interval; an empty answer is never saved as a team with nobody in it.
 */
export async function runFillTick<R extends FillRules>(deps: FillTickDeps<R>): Promise<FillTickResult> {
  const readAtMs = fillReadAt(deps.nowMs);
  const result = (state: FillTickResult["state"], days: string[], wrote = false, rows: FillReadingRow[] = []): FillTickResult => ({
    readAtMs,
    days,
    state,
    wrote,
    rows: wrote ? rows.length : 0,
    measured: wrote ? rows.filter((r) => r.taken !== null).length : 0,
  });

  const rules = await deps.loadRules();
  if (!rules.ok) throw new Error(`capacity fill could not read ${rules.reason}`, { cause: rules.err });
  const offered = await deps.readOfferedDays();
  if (offered === null) throw new Error("capacity fill could not read booking-window");
  const window = capacityDays(rules.value.hours, readAtMs, rules.value.eventType.min_notice_min, offered);
  // No open day is a state the office's week is in, not a failed read.
  if (!window) return result("no-open-days", []);
  const days = window.windowDays;

  const last = await deps.readLast(days);
  // This half hour is already recorded: a rerun writes nothing, whatever changed since.
  if (last.latestReadAtMs !== null && last.latestReadAtMs >= readAtMs) return result("already-recorded", days);

  const people = await deps.loadPeople(rules.value, days);
  if (!people.ok) {
    if (people.reason === "no-advisors") return result("no-advisors", days);
    throw new Error(`capacity fill could not read ${people.reason}`, { cause: people.err });
  }
  const { rows, last: snapshots } = fillReadings({
    readAtMs,
    windowDays: days,
    bookerDays: window.bookerDays,
    hours: rules.value.hours,
    eventType: rules.value.eventType,
    people: people.value,
    last: last.byDay,
  });
  const wrote = await deps.write({ readAtMs, prevReadAtMs: last.latestReadAtMs, rows, last: snapshots });
  return result(wrote ? "recorded" : "lost-race", days, wrote, rows);
}

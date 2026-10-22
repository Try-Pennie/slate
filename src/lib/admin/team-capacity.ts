/**
 * Team capacity (#3935): for each advisor and day, how many more calls fit and how many the shift
 * could hold, and the team's totals per day. The settled design is docs/design/team-capacity.html;
 * this is its requirement 14.
 *
 * ## Calls that fit, never open start times
 *
 * The booker offers a start every 10 minutes and a call takes 20 plus a 10 minute gap, so open
 * start times overlap and counting them overstates the room several times over. What a marketing
 * decision needs is how many more leads could book, which is how many calls fit. `callsThatFit`
 * packs them earliest first in one pass, which scripts/test-team-capacity.ts holds equal to
 * booking them one at a time through the booker's own predicate.
 *
 * ## Measured with the booker's own rules (L107)
 *
 * Every slot list here comes from `computeBucketSlots`, the function the booker serves from, for a
 * pool of one advisor. Nothing re-derives working hours, office hours, notice or the gap.
 *
 * ## Time off is not taken time
 *
 * Approved time off comes off CAPACITY, so an hour off does not make a day look fuller. Time off
 * covering the whole shift makes the advisor Out, counted in neither total. Anything else on the
 * calendar (calls, blocks, a lunch that is only an event) is taken, since the calendar cannot say
 * which is which.
 *
 * Pure (luxon and the pure slot core), so the test drives it node natively.
 */
import { DateTime } from "luxon";
import { computeBucketSlots, type BusinessHoursRules, type MemberAvailability } from "../availability/compute.ts";

/** The event type fields the slot grid is laid out from, as the booker reads them. */
export interface CapacityEventType {
  duration_min: number;
  slot_interval_min: number;
  min_notice_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  daily_cap: number | null;
}

export interface TimeOffInterval {
  startMs: number;
  endMs: number;
}

/** One advisor on one day. Times are ISO instants. */
export interface AdvisorDay {
  iso: string;
  /** Calls that still fit. */
  open: number;
  /** Calls the shift could hold with an empty calendar, approved time off taken out. */
  capacity: number;
  /** Approved time off covers the whole shift. */
  out: boolean;
  /** Working hours hold nothing this day. */
  noShift: boolean;
  /** Where each call that still fits starts. */
  openTimes: string[];
  /** The first and last start the remaining shift could hold, for drawing it. */
  shiftStart: string | null;
  shiftEnd: string | null;
  /** The whole shift ignoring the clock (today's past hours included), start and end. */
  fullShiftStart: string | null;
  fullShiftEnd: string | null;
  /** Approved time off inside the day, for drawing. */
  timeOff: { start: string; end: string }[];
}

/** How far after a call's start the next call can start: its length and the gap before the next. */
export function callStepMs(eventType: Pick<CapacityEventType, "duration_min" | "buffer_before_min">): number {
  return (eventType.duration_min + eventType.buffer_before_min) * 60_000;
}

/**
 * The starts of the calls that fit among `slots` (the booker's open starts, ascending), packed
 * earliest first. A booked call is busy for its own length only and a later start needs its gap
 * before clear of it, so after a call at S the next fits at S + duration + gap before or later.
 */
export function callsThatFit(
  slots: string[],
  eventType: Pick<CapacityEventType, "duration_min" | "buffer_before_min">,
  /** A call already packed before these, at this start: packing carries on after it (#3940). */
  afterStartMs: number | null = null,
): string[] {
  const step = callStepMs(eventType);
  const picked: string[] = [];
  let nextMs = afterStartMs === null ? -Infinity : afterStartMs + step;
  for (const s of slots) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) throw new Error(`an open start the booker returned is unreadable: "${s}"`);
    if (ms < nextMs) continue;
    picked.push(s);
    nextMs = ms + step;
  }
  return picked;
}

export interface AdvisorDayInput {
  member: MemberAvailability;
  timeOff: TimeOffInterval[];
  /** The day's start in the office's zone. */
  day: DateTime;
  eventType: CapacityEventType;
  hours: BusinessHoursRules;
  nowMs: number;
}

/** The booker's open starts for one advisor on one day, against `busy`, as seen at `at`. */
function daySlots(input: AdvisorDayInput, busy: { start: number; end: number }[], at: number, counts: Map<string, number> = new Map()): string[] {
  const { member, day, eventType, hours } = input;
  const fromMs = day.toMillis();
  const toMs = day.plus({ days: 1 }).toMillis();
  return computeBucketSlots({
    members: [{ ...member, busy, dayCounts: counts }],
    durationMin: eventType.duration_min,
    bufferBeforeMin: eventType.buffer_before_min,
    bufferAfterMin: eventType.buffer_after_min,
    minNoticeMin: eventType.min_notice_min,
    dailyCap: eventType.daily_cap,
    slotIntervalMin: eventType.slot_interval_min,
    businessHours: hours,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    nowMs: at,
  });
}

/** Approved time off clipped to the day, so time off spanning midnight counts only its part of it. */
function dayTimeOff(input: AdvisorDayInput): { start: number; end: number }[] {
  const fromMs = input.day.toMillis();
  const toMs = input.day.plus({ days: 1 }).toMillis();
  return input.timeOff
    .map((t) => ({ start: Math.max(t.startMs, fromMs), end: Math.min(t.endMs, toMs) }))
    .filter((t) => t.end > t.start);
}

/**
 * Every start the booker offers this advisor on the day as seen at `input.nowMs`, before packing:
 * their calendar and time off both taken. History packs these itself, carrying on from the calls
 * it saved earlier in the day (#3940).
 */
export function openStartsAt(input: AdvisorDayInput): string[] {
  return daySlots(input, [...input.member.busy, ...dayTimeOff(input)], input.nowMs, input.member.dayCounts ?? new Map());
}

/** The calls the advisor has booked on the office day, for a daily cap, counted on their own day. */
export function bookedOnDay(member: MemberAvailability, day: DateTime): number {
  // The office day's middle, in the advisor's zone: its midnight is the previous evening west of it.
  return member.dayCounts?.get(day.plus({ hours: 12 }).setZone(member.timezone).toISODate() ?? "") ?? 0;
}

/** One advisor's day, every number from the booker's own slot rules. */
export function advisorDay(input: AdvisorDayInput): AdvisorDay {
  const { member, day, eventType, nowMs } = input;
  const fromMs = day.toMillis();
  // `counts` is the advisor's booked calls per local day, for a daily cap: their real counts for
  // what is still open, none for what an empty calendar could hold.
  const slots = (busy: { start: number; end: number }[], at: number, counts: Map<string, number> = new Map()) => daySlots(input, busy, at, counts);
  const off = dayTimeOff(input);
  // "Ignoring the clock": the day as it looked from before it began.
  const beforeDay = fromMs - 86_400_000;

  // A daily cap limits how many calls a day can take, which one slot list cannot show: it offers
  // every start while under the cap. So the packed calls stop at whatever the cap leaves.
  const cap = eventType.daily_cap;
  const bookedToday = bookedOnDay(member, day);
  const capped = (picked: string[], already: number) => (cap === null ? picked : picked.slice(0, Math.max(0, cap - already)));
  const open = capped(callsThatFit(slots([...member.busy, ...off], nowMs, member.dayCounts ?? new Map()), eventType), bookedToday);
  const capacity = capped(callsThatFit(slots(off, nowMs), eventType), 0);
  const remainingShift = callsThatFit(slots([], nowMs), eventType);
  const wholeShift = slots([], beforeDay);
  const wholeWithOff = slots(off, beforeDay);

  const durationMs = eventType.duration_min * 60_000;
  return {
    iso: day.toISODate() ?? "",
    open: open.length,
    capacity: capacity.length,
    out: wholeShift.length > 0 && wholeWithOff.length === 0,
    noShift: wholeShift.length === 0,
    openTimes: open,
    shiftStart: remainingShift[0] ?? null,
    shiftEnd: remainingShift.at(-1) ?? null,
    fullShiftStart: wholeShift[0] ?? null,
    fullShiftEnd: wholeShift.length ? new Date(Date.parse(wholeShift.at(-1)!) + durationMs).toISOString() : null,
    timeOff: off.map((t) => ({ start: new Date(t.start).toISOString(), end: new Date(t.end).toISOString() })),
  };
}

export interface DayTotals {
  open: number;
  capacity: number;
  out: number;
  notCounted: number;
  /** Share of capacity used, rounded down and never 100 while a call is open; null when nobody works. */
  fullPct: number | null;
}

/** The team's totals for one day: out and not syncing advisors count in neither number. */
export function dayTotals(advisors: { unsynced: boolean; days: Pick<AdvisorDay, "open" | "capacity" | "out">[] }[], dayIndex: number): DayTotals {
  let open = 0, capacity = 0, out = 0, notCounted = 0;
  for (const a of advisors) {
    const d = a.days[dayIndex];
    if (a.unsynced) { notCounted++; continue; }
    if (d.out) { out++; continue; }
    open += d.open;
    capacity += d.capacity;
  }
  // Whole numbers throughout: 100 * (1 - 3 / 20) is 84.999... in floating point, which floors a
  // day sitting exactly on the line to one under it.
  const fullPct = capacity === 0 ? null : open === 0 ? 100 : Math.min(99, Math.floor((100 * (capacity - open)) / capacity));
  return { open, capacity, out, notCounted, fullPct };
}

/** Full when no call is left on a day someone works; nearly full at or over the stored line. */
export function dayFlag(t: Pick<DayTotals, "open" | "capacity" | "fullPct">, nearlyFullPct: number): "full" | "nearly-full" | null {
  if (t.capacity > 0 && t.open === 0) return "full";
  if (t.fullPct !== null && t.fullPct >= nearlyFullPct) return "nearly-full";
  return null;
}

export interface TeamCapacityAdvisor {
  id: string;
  name: string;
  email: string;
  timezone: string;
  /** The advisor's calendar is persistently failing to sync, so their room cannot be trusted. */
  unsynced: boolean;
  days: AdvisorDay[];
}

export interface TeamCapacityInput {
  /** The office local dates to report, in order. */
  days: string[];
  roster: { id: string; name: string | null; email: string }[];
  /** The booker's availability per advisor, as `loadMembersAvailability` assembles it. */
  members: MemberAvailability[];
  timeOff: Map<string, TimeOffInterval[]>;
  /** Emails whose calendars are persistently failing (`loadFailingAgents("sync")`). */
  failingEmails: Set<string>;
  eventType: CapacityEventType;
  hours: BusinessHoursRules;
  nowMs: number;
}

/** Every advisor's days, ordered by name as the design settles (D11). */
export function teamCapacityReport(input: TeamCapacityInput): { days: string[]; advisors: TeamCapacityAdvisor[] } {
  const byId = new Map(input.members.map((m) => [m.userId, m]));
  const advisors = input.roster.map((u) => {
    // The availability read returns a row for every advisor it is asked about (an advisor with no
    // schedule gets one with no rules), so a missing row means the read came back incomplete. Drawn
    // as "no shift" it would read as nobody working, so it throws and the page names the read.
    const member = byId.get(u.id);
    if (!member) throw new Error(`the availability read returned no row for advisor ${u.id}`);
    const days = input.days.map((iso) => {
      const day = DateTime.fromISO(iso, { zone: input.hours.zone }).startOf("day");
      return advisorDay({ member, timeOff: input.timeOff.get(u.id) ?? [], day, eventType: input.eventType, hours: input.hours, nowMs: input.nowMs });
    });
    return { id: u.id, name: u.name ?? u.email, email: u.email, timezone: member.timezone, unsynced: input.failingEmails.has(u.email), days };
  });
  advisors.sort((a, b) => a.name.localeCompare(b.name));
  return { days: input.days, advisors };
}

import { DateTime } from "luxon";

/**
 * Cal.com date overrides for an agent's approved time off.
 *
 * **The unit of the write is the DATE, not the request** (#2417). Cal.com date
 * overrides are ADDITIVE per date: every override on a date widens what that
 * date offers. The original port of the Apps Script derived a date's override
 * from ONE request and merged it into whatever cal.com already held, which is
 * correct for one absence and wrong for two. An agent working 09:00 to 17:00
 * with an approved absence 09:00 to 12:00 and another 13:00 to 17:00 got the
 * overrides `12:00-17:00` and `09:00-13:00`, whose union is the whole working
 * day: cal.com, which still takes every real booking until cutover, then booked
 * them straight through both absences while Slate's own busy blocks correctly
 * held the hours. Removal had the mirror of the same fault, subtracting one
 * request's key rather than recomputing what the date should now offer.
 *
 * So `recomputeOverrides` takes ALL of the agent's approved absences touching
 * the dates being rewritten, subtracts every one of them from that date's
 * working hours, and writes the intervals that are LEFT. Approval, cancellation
 * and a narrowing edit are the same computation over a different window set
 * (L14), and running it twice lands on the same answer.
 *
 * The consequence worth naming: rewriting a date replaces every override on it,
 * including one somebody set by hand in the cal.com UI. That is deliberate. An
 * override Slate did not compute is additive against the ones it did, which is
 * the exact shape of the defect above, so a date Slate is protecting has to be
 * exactly what Slate computed. (The PATCH already replaced the whole override
 * list, so a concurrent UI edit was never safe here.)
 *
 * All math happens in the cal.com schedule's own timezone, in wall-clock
 * minutes, because the working week is stated in wall-clock hours and a
 * daylight-saving day is 23 or 25 hours long.
 *
 * Exercised by `scripts/test-ooo-calcom-overrides.ts`.
 */

export interface CalcomAvailabilityRule {
  /** Cal.com sends day names ("Monday") or numbers (Sunday=0). */
  days?: (string | number)[];
  startTime?: string; // "HH:mm"
  endTime?: string;
}

export interface DateOverride {
  date: string; // "yyyy-MM-dd" in the schedule tz
  startTime: string; // "HH:mm"
  endTime: string;
}

/** One approved absence, as the database holds it. */
export interface AbsenceWindow {
  startIso: string;
  endIso: string;
}

/**
 * Cal.com's representation of "not available at all on this date": an override
 * whose start and end are the same instant, so it offers no bookable time.
 *
 * This is what the Apps Script wrote and what Slate has written throughout the
 * parallel run, so it is the shipped meaning rather than a new guess. It matters
 * that a fully covered day produces THIS and not an empty list: an empty list is
 * "no override on this date", which falls back to the normal working week and
 * leaves the agent bookable through an absence that covers all of it.
 */
export const FULL_DAY_BLOCK = { startTime: "00:00", endTime: "00:00" } as const;

const MINUTES_IN_DAY = 1440;

/** A window longer than this is corrupt data, not an absence. Refuse it. */
const MAX_ABSENCE_DAYS = 400;

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const hhmmOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** The schedule's zone, falling back to UTC when cal.com sends one Luxon rejects. */
function resolveZone(scheduleTz: string): string {
  return DateTime.local().setZone(scheduleTz).isValid ? scheduleTz : "Etc/UTC";
}

/** Working hours for a local date, from the schedule's weekly availability. */
function workingHoursFor(
  localDate: string,
  zone: string,
  availability: CalcomAvailabilityRule[] | undefined,
): { startTime: string; endTime: string } | null {
  if (!Array.isArray(availability)) return null;
  // Luxon weekday 1=Mon..7=Sun -> Cal.com Sunday=0 numbering.
  const luxonWeekday = DateTime.fromISO(localDate, { zone }).weekday;
  const calcomDay = luxonWeekday % 7;
  const dayName = DAY_NAMES[calcomDay];
  for (const rule of availability) {
    if (!rule.days || !rule.startTime || !rule.endTime) continue;
    if (rule.days.some((d) => d === calcomDay || d === dayName)) {
      return { startTime: rule.startTime, endTime: rule.endTime };
    }
  }
  return null;
}

type Span = [number, number];

/**
 * The wall-clock minutes of `date` that the absences cover, clipped to the date.
 *
 * `null` means a window could not be read, and the caller refuses on it rather
 * than writing an override computed from a set it knows is incomplete: an
 * absence dropped here is an hour cal.com would offer (L214).
 */
function absentSpansOn(
  date: string,
  zone: string,
  windows: AbsenceWindow[],
): Span[] | null {
  const dayStart = DateTime.fromISO(date, { zone }).startOf("day");
  if (!dayStart.isValid) return null;
  const nextDayStart = dayStart.plus({ days: 1 });
  const out: Span[] = [];
  for (const w of windows) {
    const s = DateTime.fromISO(w.startIso, { zone });
    const e = DateTime.fromISO(w.endIso, { zone });
    if (!s.isValid || !e.isValid) return null;
    // Inverted is corrupt and must not be silently skipped; equal is a
    // zero-length window, which covers nothing and is not a fault.
    if (e < s) return null;
    if (e.toMillis() === s.toMillis()) continue;
    if (e <= dayStart || s >= nextDayStart) continue;
    const startMin = s <= dayStart ? 0 : s.hour * 60 + s.minute;
    const endMin = e >= nextDayStart ? MINUTES_IN_DAY : e.hour * 60 + e.minute;
    if (endMin > startMin) out.push([startMin, endMin]);
  }
  return out;
}

/** `range` with every span removed, in order. */
function subtractSpans(range: Span, spans: Span[]): Span[] {
  let free: Span[] = range[1] > range[0] ? [[range[0], range[1]]] : [];
  for (const [s, e] of spans) {
    const next: Span[] = [];
    for (const [a, b] of free) {
      if (e <= a || s >= b) {
        next.push([a, b]);
        continue;
      }
      if (s > a) next.push([a, Math.min(s, b)]);
      if (e < b) next.push([Math.max(e, a), b]);
    }
    free = next;
  }
  return free;
}

/**
 * What one date should offer, given every absence touching it.
 *
 * `null` propagates an unreadable window. An empty array means "write no
 * override for this date", which is correct in exactly two cases: no absence
 * touches it at all, and the absences fall entirely outside the working hours so
 * the normal week is already right.
 */
function overridesForDate(
  date: string,
  zone: string,
  windows: AbsenceWindow[],
  availability: CalcomAvailabilityRule[] | undefined,
): DateOverride[] | null {
  const absences = absentSpansOn(date, zone, windows);
  if (absences === null) return null;
  if (absences.length === 0) return [];

  const work = workingHoursFor(date, zone, availability);
  // No working hours on file: block the day outright (parity with the legacy
  // tool, and with #2417's rule that an unknown schedule must never stay
  // bookable through an absence).
  if (!work) return [{ date, ...FULL_DAY_BLOCK }];

  const workStart = minutesOf(work.startTime);
  const workEnd = minutesOf(work.endTime);
  const free = subtractSpans([workStart, workEnd], absences);

  // Nothing of the working day was taken: leave the normal week in place rather
  // than writing an override that merely restates it.
  if (
    free.length === 1 &&
    free[0][0] === workStart &&
    free[0][1] === workEnd
  ) {
    return [];
  }
  if (free.length === 0) return [{ date, ...FULL_DAY_BLOCK }];
  return free.map(([s, e]) => ({
    date,
    startTime: hhmmOf(s),
    endTime: hhmmOf(e),
  }));
}

/**
 * The local dates (in the schedule's zone) an absence touches, which is the set
 * of dates whose overrides have to be rewritten.
 *
 * `null` when the window cannot be read or is implausible, so the caller refuses
 * rather than rewriting a date set it guessed. A window ending exactly at
 * midnight does NOT claim the following date: nothing of it is absent there, and
 * naming it would have the write replace that date's overrides for no reason.
 */
export function datesCoveredBy(
  startIso: string,
  endIso: string,
  scheduleTz: string,
): string[] | null {
  const zone = resolveZone(scheduleTz);
  const s = DateTime.fromISO(startIso, { zone });
  const e = DateTime.fromISO(endIso, { zone });
  if (!s.isValid || !e.isValid) return null;
  if (e < s) return null;
  if (e.toMillis() === s.toMillis()) return [];
  const lastInstant = e.toMillis() === e.startOf("day").toMillis() ? e.minus({ minutes: 1 }) : e;
  const lastDate = lastInstant.startOf("day");
  const out: string[] = [];
  let cursor = s.startOf("day");
  while (cursor <= lastDate) {
    if (out.length >= MAX_ABSENCE_DAYS) return null;
    out.push(cursor.toISODate()!);
    cursor = cursor.plus({ days: 1 });
  }
  return out;
}

export type RecomputeResult =
  | {
      ok: true;
      /** The whole override list to PATCH: untouched dates plus the rewritten ones. */
      overrides: DateOverride[];
      /** How many existing overrides sat on the rewritten dates and were replaced. */
      replaced: number;
    }
  | { ok: false; reason: string };

/**
 * Rewrite `dates` from `windows`, keeping every override on other dates.
 *
 * `windows` is the COMPLETE set of the agent's approved absences that could
 * touch those dates: the caller adds the absence being approved and leaves out
 * the one being cancelled, so add and remove are one computation (L14) and a
 * repeat of either converges on the same answer rather than compounding.
 */
export function recomputeOverrides(args: {
  existing: DateOverride[];
  dates: string[];
  windows: AbsenceWindow[];
  scheduleTz: string;
  availability: CalcomAvailabilityRule[] | undefined;
}): RecomputeResult {
  const zone = resolveZone(args.scheduleTz);
  const dates = [...new Set(args.dates)].sort();
  const affected = new Set(dates);
  const kept = args.existing.filter((o) => !affected.has(o.date));
  const fresh: DateOverride[] = [];
  for (const date of dates) {
    const forDate = overridesForDate(date, zone, args.windows, args.availability);
    if (forDate === null) {
      return {
        ok: false,
        reason: `an approved time off window for ${date} could not be read`,
      };
    }
    fresh.push(...forDate);
  }
  return {
    ok: true,
    overrides: [...kept, ...fresh],
    replaced: args.existing.length - kept.length,
  };
}

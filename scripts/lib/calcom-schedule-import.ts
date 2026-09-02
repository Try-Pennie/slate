// Map a cal.com default schedule onto Slate's availability rules (#1738, #1739).
// Pure: no network, no clock, no database, so every refusal is driven offline by
// `scripts/test-calcom-schedule-import.ts`.
//
// WHY THIS EXISTS. Slate holds one seeded window for the entire roster (Mon to Fri,
// 08:00 to 17:00, `America/New_York` for all 117 rows) and nobody has ever edited
// it. cal.com holds what the agents have actually been maintaining. Measured
// 2026-09-02: 81 of 100 have different hours, and 74 of 103 are not Eastern.
//
// THE ZONE AND THE HOURS TRAVEL TOGETHER. `availability_rules` stores minutes from
// local midnight, interpreted in `availability_schedules.timezone`. Importing hours
// without the zone moves an agent's window to their real local hours while Slate
// goes on reading it as Eastern, which shifts the error rather than removing it: a
// Phoenix agent becomes differently wrong, and nothing reports either state.
//
// EVERY UNREADABLE INPUT IS REFUSED. Defaulting to Eastern is exactly how the roster
// came to claim a timezone three quarters of it does not have, so a mapping that
// quietly fell back would recreate the defect it exists to fix.
import { DateTime } from "luxon";

/** Luxon's convention, which is Slate's: 1 = Monday .. 7 = Sunday. */
const WEEKDAY: Record<string, number> = {
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
  Sunday: 7,
};

export interface SlateRule {
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export interface SlateSchedule {
  timezone: string;
  rules: SlateRule[];
}

interface CalcomAvailability {
  days?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

export interface CalcomSchedule {
  timeZone?: unknown;
  availability?: unknown;
}

type Mapped = ({ ok: true } & SlateSchedule) | { ok: false; why: string };

/** "HH:MM" to minutes from midnight, or null when it is not that. */
function minutesFromClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function mapCalcomSchedule(schedule: CalcomSchedule): Mapped {
  const zone = schedule.timeZone;
  if (typeof zone !== "string" || zone.trim() === "") {
    return { ok: false, why: "the schedule carries no timezone" };
  }
  // Checked against a real clock rather than a list we maintain: a zone Luxon
  // cannot resolve would be written and then silently fall back at read time.
  if (!DateTime.local().setZone(zone).isValid) {
    return { ok: false, why: `the timezone is one no clock recognises: ${zone}` };
  }
  const list = schedule.availability;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, why: "the schedule carries no availability windows" };
  }

  const rules: SlateRule[] = [];
  for (const entry of list as CalcomAvailability[]) {
    const start = minutesFromClock(entry?.startTime);
    const end = minutesFromClock(entry?.endTime);
    if (start === null) return { ok: false, why: `unreadable start time: ${String(entry?.startTime)}` };
    if (end === null) return { ok: false, why: `unreadable end time: ${String(entry?.endTime)}` };
    // Slate's rules live inside ONE local day, so a window that ends at or before
    // it starts cannot be represented. Writing it anyway produces a day of zero or
    // negative length that offers nothing and looks like a configured day.
    if (end <= start) {
      return { ok: false, why: `a window that does not end after it starts: ${String(entry?.startTime)} to ${String(entry?.endTime)}` };
    }
    const days = entry?.days;
    if (!Array.isArray(days) || days.length === 0) {
      return { ok: false, why: "an availability window names no days" };
    }
    for (const day of days) {
      const weekday = typeof day === "string" ? WEEKDAY[day] : undefined;
      // One unrecognised day REFUSES the whole schedule rather than being skipped.
      // Skipping would produce a shorter week that still reads as a real answer,
      // and the agent would simply stop being offered on that day with nothing said.
      if (!weekday) return { ok: false, why: `unrecognised day name: ${String(day)}` };
      rules.push({ weekday, start_minute: start, end_minute: end });
    }
  }
  rules.sort((a, b) => a.weekday - b.weekday || a.start_minute - b.start_minute);
  return { ok: true, timezone: zone, rules };
}

/** A stable rendering of a week, so two schedules can be compared by VALUE. */
function fingerprint(rules: SlateRule[]): string {
  return [...rules]
    .map((r) => `${r.weekday}:${r.start_minute}-${r.end_minute}`)
    .sort()
    .join(",");
}

/**
 * What would change for one agent, and why, in words a person can act on.
 *
 * The timezone is compared FIRST and on its own, because the roster's commonest
 * real case is identical clock numbers in a different zone. Those rows look
 * byte-identical in `availability_rules` and mean completely different instants, so
 * a diff that only compared the numbers would report the largest population of
 * broken agents as needing no change at all.
 */
export function diffSchedule(
  current: SlateSchedule,
  incoming: SlateSchedule,
): { changed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (current.timezone !== incoming.timezone) {
    reasons.push(`timezone ${current.timezone} to ${incoming.timezone}`);
  }
  const currentDays = [...new Set(current.rules.map((r) => r.weekday))].sort().join("");
  const incomingDays = [...new Set(incoming.rules.map((r) => r.weekday))].sort().join("");
  if (currentDays !== incomingDays) {
    reasons.push(`days ${currentDays || "none"} to ${incomingDays || "none"}`);
  } else if (fingerprint(current.rules) !== fingerprint(incoming.rules)) {
    // Only reported when the DAYS already match, so one agent's change is named
    // once by its most specific cause rather than twice by two overlapping ones.
    reasons.push("hours changed");
  }
  return { changed: reasons.length > 0, reasons };
}

/**
 * How long to wait before retrying a cal.com read, or null to stop trying.
 *
 * The first real import run met this at agent 15: cal.com answered 429 for 89 of
 * 103 agents. Pure and injectable-free so the ladder is driven offline rather than
 * by making a real run slow enough to observe (L524).
 *
 * A 4xx that is not a rate limit is never retried: trying again cannot create a
 * schedule that does not exist, and hammering a system that is refusing us makes
 * the refusal worse.
 */
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;

export function retryDelayMs(
  status: number,
  retryAfterHeader: string | null,
  attempt: number,
): number | null {
  const retryable = status === 429 || status >= 500;
  if (!retryable) return null;
  if (attempt >= MAX_ATTEMPTS) return null;
  // The server's own instruction wins: it knows when it will accept us again.
  if (retryAfterHeader !== null) {
    const seconds = Number(retryAfterHeader.trim());
    // An unreadable Retry-After falls through to the backoff rather than becoming
    // NaN, which a timer treats as zero and which would turn the retry into a storm.
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  return BASE_DELAY_MS * 2 ** attempt;
}

/**
 * Whether a skipped agent needs a PERSON or just another run.
 *
 * Both were reported under one heading on the first run, which told a reader to go
 * and sort out 89 people by hand when 89 of them needed nothing but a slower retry.
 *
 * The kind is decided from the STATUS and carried on the record, never re-derived
 * from the message text later. A classifier that reads its own prose is one reworded
 * sentence away from silently reclassifying a whole population, and it cannot be
 * checked against the thing that actually failed.
 */
export type SkipKind = "transient" | "permanent";

/** The kind for a failed HTTP read. Anything not a rate limit or a server fault is
 *  permanent: another attempt cannot create a schedule that is not there. */
export function skipKindForStatus(status: number): SkipKind {
  return status === 429 || status >= 500 ? "transient" : "permanent";
}

/**
 * Milliseconds to wait between agents, from the environment.
 *
 * Handed straight to a timer, so an unreadable value must never become NaN:
 * `setTimeout(NaN)` fires immediately, which silently removes the pacing that
 * keeps a 103-agent run under cal.com's rate limit, and the run then fails the way
 * the first one did while the setting still reads as configured (L50).
 */
export const DEFAULT_PACE_MS = 250;

export function paceMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PACE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PACE_MS;
  return n;
}

/**
 * Leave out any weekday carrying more than one window, and say which.
 *
 * Slate stores ONE window per weekday, so an agent with two shifts on a Tuesday
 * cannot be represented. The two obvious repairs are both wrong: merging them into
 * 08:00 to 18:00 makes the agent bookable straight through a break they never
 * offered, and taking the first shift silently deletes the second half of their
 * day. So the split DAY is left out and every other day is imported, which is
 * Dan's call (2026-09-02): the agent ends up correct on the days we can express.
 *
 * Dropping a day is NOT free, and the caller is not allowed to forget it: that
 * agent will be offered nothing at all on the dropped day. So the days go back to
 * the caller rather than being swallowed, and the caller reports them.
 */
export function dropSplitDays(rules: SlateRule[]): { rules: SlateRule[]; droppedDays: number[] } {
  const perDay = new Map<number, number>();
  for (const r of rules) perDay.set(r.weekday, (perDay.get(r.weekday) ?? 0) + 1);
  const dropped = [...perDay.entries()].filter(([, n]) => n > 1).map(([d]) => d).sort((a, b) => a - b);
  const drop = new Set(dropped);
  return { rules: rules.filter((r) => !drop.has(r.weekday)), droppedDays: dropped };
}

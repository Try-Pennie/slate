// Map a cal.com default schedule onto Slate's availability rules (#1738, #1739).
// Pure: no network, no clock, no database, so every refusal is driven offline by
// `scripts/test-calcom-schedule-import.ts`.
//
// It lives in `src/` rather than beside the importer script (#2627) because it has
// TWO callers now: `pnpm import:calcom-schedules`, which sweeps the roster daily,
// and the activation gate in the Worker, which imports ONE agent's week the moment
// they become bookable (`src/lib/bookable/activation-hours.ts`). Both reach the
// mapping through `planImportedWeek` below, so there is one reading of a cal.com
// week and the two cannot come to disagree about what somebody works.
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
import { planScheduleReplacement } from "@/lib/schedule-replacement";
import type { HoursSource } from "@/lib/monitor/unset-hours";

/**
 * The cal.com API version the schedules endpoint answers under, measured live
 * (2024-08-13 answers 404 for it). Here rather than beside the script's reader
 * because the activation gate sends it too (#2627), and one version for one
 * endpoint is what keeps the two readings of a schedule the same shape.
 */
export const CAL_SCHEDULES_API_VERSION = "2024-09-04";

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

/** Who last wrote a Slate week, re-exported from the one place it is declared. */
export type { HoursSource };

/** The refusal for an agent's own week, in one place so the importer, the parity
 *  comparison and the tests all say the same thing about the same person (L41). */
export const AGENT_OWNS_HOURS =
  "the agent set these hours in Slate themselves, so cal.com does not overwrite them";

/**
 * Sources cal.com is allowed to replace.
 *
 * Everything NOT in this set is refused, including a name nobody has taught this
 * rule, so a writer added later defaults to leaving people's hours alone rather
 * than to overwriting them. `null` is in it deliberately and it is the whole
 * roster: measured 2026-09-10, 79 of 90 bookable agents carried no stamp at all,
 * because migration 0117 shipped six days after the import that wrote them.
 * Refusing an unstamped week would leave this inert for 88 percent of the roster
 * while the daily page went on naming exactly the agents it would not fix (L662).
 */
const OVERWRITABLE: readonly (HoursSource | null)[] = [null, "seed", "admin", "calcom-import"];

/**
 * Whether cal.com may overwrite the week Slate holds for an agent, and why not.
 *
 * This is the guard #2092 rests on. The daily lane applies a drift correction
 * itself now, so the importer runs unattended every morning, and the one thing an
 * unattended writer must never do is replace hours somebody set for themselves.
 * cal.com is the authority for these values ONLY while it is the system people
 * maintain, and an agent who has set their own week in Slate has stopped being one
 * of those people. It is also the guard that survives cutover (#65) without anybody
 * remembering to switch it off: once agents set their own hours (#1454) every one
 * of those rows is stamped `agent` by construction, and this stops touching them.
 *
 * Dan's rule, 2026-09-10: "it just needs to not overwrite a changed hours. If I
 * changed them or another import changed them, that's fine." So an admin's edit is
 * deliberately overwritable, and only the agent's own week is not.
 *
 * Returns the reason it may not be written, or null when it may. A reason rather
 * than a boolean, so the sentence a person reads is derived here and cannot drift
 * from the rule that produced it.
 */
export function hoursOverwriteRefusal(hoursSource: string | null): string | null {
  if (OVERWRITABLE.includes(hoursSource as HoursSource | null)) return null;
  if (hoursSource === "agent") return AGENT_OWNS_HOURS;
  return `Slate does not recognise who wrote these hours (${hoursSource}), so cal.com leaves them alone`;
}

/**
 * What the daily import does with one agent, decided from who last wrote their week
 * and whether it differs from cal.com.
 *
 * - `write`: the week differs and cal.com may replace it (`hoursOverwriteRefusal`).
 * - `left-alone`: the week differs and cal.com may not replace it.
 * - `stamp`: the week already matches and carries NO source. Those are weeks written
 *   before migration 0117 (#1753) recorded who sets hours; matching weeks were never
 *   written, so their source stayed null for ever and the console's Team hours
 *   "Set by" column was blank for 52 of 98 bookable advisors (2026-10-02). The stamp
 *   records `calcom-import` without touching the rules or the zone.
 * - `match`: the week already matches and its source is already recorded. A
 *   matching `seed` week stays `seed` on purpose: whether somebody really keeps the
 *   seeded hours, or both systems inherited one default, is a separate question, and
 *   restamping it would answer that question by accident.
 *
 * Only a null source is ever stamped, so a second run reads the same agent as a
 * plain match and does nothing.
 */
export type ImportAction =
  | { kind: "write" }
  | { kind: "left-alone"; why: string }
  | { kind: "stamp" }
  | { kind: "match" };

export function importAction(hoursSource: string | null, changed: boolean): ImportAction {
  if (!changed) return hoursSource === null ? { kind: "stamp" } : { kind: "match" };
  // Asked AFTER the diff, never before it: an agent who owns their week and happens
  // to match cal.com is not a finding (L36).
  const refusal = hoursOverwriteRefusal(hoursSource);
  return refusal === null ? { kind: "write" } : { kind: "left-alone", why: refusal };
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
  return retryAfterMs(retryAfterHeader) ?? BASE_DELAY_MS * 2 ** attempt;
}

/**
 * A Retry-After header in milliseconds, or null when there is none or it cannot be
 * read. Shared by the ladder above and the second read after a sweep (#3963), so
 * the two can never disagree about what cal.com asked for.
 *
 * An unreadable value is null rather than NaN, which a timer treats as zero and
 * which would turn a retry into a storm. Only the seconds form is read; an HTTP
 * date is treated as unreadable and the caller's own backoff applies.
 */
export function retryAfterMs(header: string | null | undefined): number | null {
  if (header === null || header === undefined || header.trim() === "") return null;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
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

export type DefaultSchedule =
  | { kind: "schedule"; schedule: unknown }
  /** The account exists and owns no schedule. A real state, not a fault. */
  | { kind: "none" }
  /** The payload is not the shape the contract promises. Kept apart from `none`
   *  because it means the API changed under us rather than that an agent has
   *  nothing set, and those send two different people to do two different things. */
  | { kind: "unreadable"; why: string };

/**
 * Which of a user's schedules is the one their bookings are actually taken
 * against.
 *
 * cal.com returns every schedule a user owns. Comparing Slate against a holiday
 * cover week nobody books through would report drift that does not exist, so the
 * DEFAULT is taken. A lone schedule with no flag is still taken: cal.com does not
 * always set it, and refusing those would strand a real slice of this roster.
 */
export function pickDefaultSchedule(payload: unknown): DefaultSchedule {
  if (payload === null || typeof payload !== "object") {
    return { kind: "unreadable", why: "the schedules payload is not an object" };
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return { kind: "unreadable", why: "the schedules payload carries no list of schedules" };
  }
  if (data.length === 0) return { kind: "none" };
  const chosen = (data as { isDefault?: unknown }[]).find((s) => s?.isDefault === true) ?? data[0];
  return { kind: "schedule", schedule: chosen };
}

/**
 * A cal.com schedule turned into the week Slate would write, or the reason it
 * cannot be.
 *
 * THE ONE READING of a cal.com week (#2627): the importer's roster sweep and the
 * activation gate both call this, and neither maps a schedule any other way. It is
 * the mapping, then the empty check, then Slate's own validator
 * (`planScheduleReplacement`, the one every hours editor goes through), in the
 * order the importer has always applied them.
 */
export type PlannedWeek =
  | { ok: true; timezone: string; rules: SlateRule[] }
  | { ok: false; why: string };

export function planImportedWeek(calSchedule: unknown): PlannedWeek {
  const mapped = mapCalcomSchedule((calSchedule ?? {}) as CalcomSchedule);
  if (!mapped.ok) return { ok: false, why: mapped.why };
  // Split shifts come across whole (#1782). Slate held one window per weekday until
  // then, so a day with two was left out and the agent was offered nothing on it;
  // `planScheduleReplacement` now refuses only windows that OVERLAP each other, and
  // names the day when it does.
  if (mapped.rules.length === 0) return { ok: false, why: "the schedule has no usable days" };
  const plan = planScheduleReplacement(mapped.rules, mapped.timezone);
  if (!plan.ok) return { ok: false, why: `Slate will not accept this week: ${plan.error}` };
  return { ok: true, timezone: plan.timezone, rules: plan.rules };
}

/**
 * The times a program lead is shown (#4390, phase 4 of #4255): the real cached slots
 * PLUS the placeholder advisor's starts, so a program lead may book a time no real
 * advisor is free for, up to the placeholder day limit.
 *
 * The placeholder's starts come from the coordinator page's ONE start predicate
 * (`offeredDays`, `bookable-hours.ts`): Pennie's business hours for the whole call, the
 * lead's calling window in the zone the booker shows them, the horizon and nothing in
 * the past, extended here with the event type's minimum notice and slot interval, so a
 * placeholder start meets every rule a real slot meets and sits on the same grid
 * (`scripts/test-program-lead-times.ts` holds the two side by side).
 *
 * A day whose held count (`placeholder_day_counts`, migration 0213) is at
 * `booking_settings.placeholder_day_limit` shows real slots only. The day is the Eastern
 * day of the CALL (`placeholderCallDay`), the day the SQL counts by.
 *
 * Every read that fails (the token secret, the settings, the hours, the horizon, the day
 * counts) shows real slots only, the harmless side, AND is counted
 * (`program_lead_outcomes`, kind `times_fallback`, migration 0215): a fallback that is
 * only logged is rare by construction and its collapse to zero moves no rate (L654).
 * The switch off, no token and a refused token are not failures: real slots only,
 * nothing counted.
 *
 * Pure apart from the injected deps (relative imports), so the node suite runs it; the
 * live wiring is `program-lead-times-live.ts`.
 */
import { DateTime } from "luxon";
import type { BusinessHoursRules } from "../availability/compute.ts";
import { offeredDays } from "../coordinator/bookable-hours.ts";
import { leadCallingZone } from "./lead-calling-window.ts";
import type { ProgramLeadTokenRefusal } from "./program-lead-token.ts";

/** The zone a placeholder call's day is counted in: the one `placeholder_day_held` uses. */
export const PLACEHOLDER_DAY_ZONE = "America/New_York";

/** The Eastern day (YYYY-MM-DD) a call starting at `startMs` counts on. */
export function placeholderCallDay(startMs: number): string {
  return DateTime.fromMillis(startMs, { zone: PLACEHOLDER_DAY_ZONE }).toISODate() ?? "";
}

/**
 * The instant the Eastern day `day` (YYYY-MM-DD) begins: the lower bound
 * `placeholder_day_held` reads a day's calls from. A day is never its start plus 24
 * hours, because the day the clocks go back is 25 hours long (#4392).
 */
export function placeholderDayStartMs(day: string): number {
  return DateTime.fromISO(day, { zone: PLACEHOLDER_DAY_ZONE }).startOf("day").toMillis();
}

/** The `count` Eastern days ending with today, newest first (#4392). */
export function placeholderDaysBack(nowMs: number, count: number): string[] {
  const today = DateTime.fromMillis(nowMs, { zone: PLACEHOLDER_DAY_ZONE }).startOf("day");
  return Array.from({ length: count }, (_, i) => today.minus({ days: i }).toISODate() ?? "");
}

/** The event type's three facts the starts depend on. */
export interface ProgramTimesEventType {
  duration_min: number;
  slot_interval_min: number;
  min_notice_min: number;
}

/** The placeholder's starts, ascending, spelled as the real slots are (UTC ISO). */
export function placeholderStarts(input: {
  hours: BusinessHoursRules;
  /** The zone the booker shows the lead; unreadable is judged as the confirm judges it. */
  zone: string | null;
  nowMs: number;
  horizonDays: number;
  eventType: ProgramTimesEventType;
}): string[] {
  return offeredDays({
    hours: input.hours,
    zone: leadCallingZone(input.zone),
    durationMin: input.eventType.duration_min,
    nowMs: input.nowMs,
    horizonDays: input.horizonDays,
    minNoticeMin: input.eventType.min_notice_min,
    stepMin: input.eventType.slot_interval_min,
  }).flatMap((day) => day.starts.map((iso) => new Date(Date.parse(iso)).toISOString()));
}

/**
 * The real slots and the placeholder's starts as one list, in time order. A start both
 * offer is shown once, as the real slot (its own spelling), and only the starts no real
 * advisor offers are marked as the placeholder's. A placeholder start on a day at the
 * limit, or a day the counts do not name, is left out.
 */
export function mergeProgramLeadTimes(input: {
  realSlots: string[];
  placeholder: string[];
  heldByDay: Map<string, number>;
  dayLimit: number;
}): { slots: string[]; placeholderStarts: string[] } {
  const realMs = new Set<number>();
  for (const iso of input.realSlots) realMs.add(Date.parse(iso));
  const extra: { iso: string; ms: number }[] = [];
  for (const iso of input.placeholder) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms) || realMs.has(ms)) continue;
    const held = input.heldByDay.get(placeholderCallDay(ms));
    if (held === undefined || held >= input.dayLimit) continue;
    extra.push({ iso, ms });
  }
  if (extra.length === 0) return { slots: input.realSlots, placeholderStarts: [] };
  const all = [
    ...input.realSlots.map((iso) => ({ iso, ms: Date.parse(iso) })),
    ...extra,
  ].sort((a, b) => a.ms - b.ms);
  return { slots: all.map((s) => s.iso), placeholderStarts: extra.map((s) => s.iso) };
}

/** Why a program lead was shown real slots only although they carried a good token. */
export const PROGRAM_TIMES_FALLBACKS = [
  "token-secret-unset",
  "settings-unreadable",
  "hours-unreadable",
  "horizon-unreadable",
  "counts-unreadable",
] as const;
export type ProgramTimesFallback = (typeof PROGRAM_TIMES_FALLBACKS)[number];

export interface ProgramLeadTimesDeps {
  /** The token judged as issued (`readProgramLeadTokenAsIssued`). Never logs the token. */
  readToken(token: string): { ok: true } | { ok: false; reason: ProgramLeadTokenRefusal };
  /** The go live switch and the day limit in one read, or null when it failed. */
  readSettings(): Promise<{ enabled: boolean; dayLimit: number } | null>;
  /** Pennie's week. THROWS on an unreadable one. */
  loadHours(): Promise<BusinessHoursRules>;
  /** The booking horizon in open days, or null when it could not be read. */
  readHorizonDays(): Promise<number | null>;
  /** The held count per Eastern day from `fromDay` to `toDay` inclusive. THROWS on failure. */
  readDayCounts(fromDay: string, toDay: string): Promise<Map<string, number>>;
  /** Count one fallback on today's Eastern day. May throw; a failure here never fails the times. */
  countFallback(reason: ProgramTimesFallback): Promise<void>;
  now(): number;
}

export type ProgramLeadTimesOutcome =
  | "ordinary"
  | "token-refused"
  | "switch-off"
  | "program"
  | `fallback:${ProgramTimesFallback}`;

export interface ProgramLeadTimes {
  /** What to serve: the real slots, plus the placeholder's starts on a program read. */
  slots: string[];
  /** The served starts only the placeholder offers. Empty unless the outcome is `program`. */
  placeholderStarts: string[];
  outcome: ProgramLeadTimesOutcome;
  /** Set when counting the fallback itself failed, so the caller can say so in its log. */
  countFailed?: unknown;
}

/**
 * The times for one request. `realSlots` are already through every filter the request
 * applies to real slots before its window (notice included); the caller applies its window
 * to the result. `fromMs` leaves out placeholder starts before it, for the look further
 * ahead past a closure, whose real slots start where the ordinary search stopped. Never
 * throws: every failure is real slots only.
 */
export async function programLeadTimes(
  input: {
    token: string | null;
    leadZone: string | null;
    realSlots: string[];
    eventType: ProgramTimesEventType;
    fromMs?: number;
  },
  deps: ProgramLeadTimesDeps,
): Promise<ProgramLeadTimes> {
  const real = (outcome: ProgramLeadTimesOutcome): ProgramLeadTimes => ({
    slots: input.realSlots,
    placeholderStarts: [],
    outcome,
  });
  const fallback = async (reason: ProgramTimesFallback): Promise<ProgramLeadTimes> => {
    const out = real(`fallback:${reason}`);
    try {
      await deps.countFallback(reason);
    } catch (err) {
      out.countFailed = err;
    }
    return out;
  };

  if (!input.token) return real("ordinary");
  const token = deps.readToken(input.token);
  if (!token.ok) return token.reason === "secret-unset" ? fallback("token-secret-unset") : real("token-refused");

  const [settings, hours, horizonDays] = await Promise.all([
    deps.readSettings().catch(() => null),
    deps.loadHours().catch(() => null),
    deps.readHorizonDays().catch(() => null),
  ]);
  if (settings === null) return fallback("settings-unreadable");
  if (!settings.enabled) return real("switch-off");
  if (hours === null) return fallback("hours-unreadable");
  if (horizonDays === null) return fallback("horizon-unreadable");

  const nowMs = deps.now();
  const starts = placeholderStarts({ hours, zone: input.leadZone, nowMs, horizonDays, eventType: input.eventType }).filter(
    (iso) => input.fromMs === undefined || Date.parse(iso) >= input.fromMs,
  );
  if (starts.length === 0) return real("program");

  // The starts are ascending, so their first and last days bound the one read.
  const fromDay = placeholderCallDay(Date.parse(starts[0]!));
  const toDay = placeholderCallDay(Date.parse(starts[starts.length - 1]!));
  let heldByDay: Map<string, number>;
  try {
    heldByDay = await deps.readDayCounts(fromDay, toDay);
  } catch {
    return fallback("counts-unreadable");
  }
  // A day the read did not name is a read that did not answer, never an empty day.
  for (const iso of starts) {
    if (!heldByDay.has(placeholderCallDay(Date.parse(iso)))) return fallback("counts-unreadable");
  }

  const merged = mergeProgramLeadTimes({ realSlots: input.realSlots, placeholder: starts, heldByDay, dayLimit: settings.dayLimit });
  return { ...merged, outcome: "program" };
}

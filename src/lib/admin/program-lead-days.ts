/**
 * The program leads admin page's last 14 Eastern days (#4392): what happened to program
 * leads each day, so an admin can see whether the placeholder day limit is right and
 * whether the extra times are reaching people.
 *
 * TWO KINDS OF DAY, said on the page as column group headings, because a reader comparing
 * them would otherwise assume one:
 *   - by the day of the CALL: program bookings, those on the placeholder, and those on the
 *     placeholder with no Regal call. The day `placeholder_day_held` counts by, so the
 *     numbers line up with the limit (`placeholderCallDay`).
 *   - by the day it HAPPENED: limit refusals and fallbacks to real times, read from
 *     `program_lead_outcomes`, whose `day` is when the bump ran (migration 0215).
 *
 * "No Regal call" is the monitor's own verdict (`judgePlaceholderCall`), never a second
 * query or a second reading of it (L342): a call is counted only once the call feed has
 * heard something after it was due, and a call it cannot judge yet is counted apart as
 * not known yet, never folded into either side.
 *
 * Pure, with relative imports, so the node suite drives it
 * (`scripts/test-program-lead-days.ts`); the reads are `program-lead-days-load.ts`.
 */
import {
  placeholderCallDay,
  placeholderDayStartMs,
  placeholderDaysBack,
} from "../booking/program-lead-times.ts";
import { parseStampMs } from "../date/stamp.ts";
import {
  judgePlaceholderCall,
  type PlaceholderBookingRow,
  type PlaceholderCallRow,
} from "../monitor/placeholder-calls.ts";

/** How many Eastern days the page shows, today included. */
export const PROGRAM_LEAD_DAYS_SHOWN = 14;

/** One `program_lead_outcomes` row as the page reads it. */
export interface ProgramLeadOutcomeRow {
  day: string;
  kind: string;
  occurrences: number;
}

/** One day's row on the page. */
export interface ProgramLeadDay {
  /** The Eastern day, YYYY-MM-DD. */
  day: string;
  /** Program bookings whose call is on this day, still on the books. */
  bookings: number;
  /** Of those, the ones on the placeholder advisor. */
  onPlaceholder: number;
  /** Of those, due with the feed alive past their due time and no Regal call. */
  noRegalCall: number;
  /** Of those, due but not judgeable yet: the feed has heard nothing since. */
  notKnownYet: number;
  /** Program bookings refused because their call's day was full, counted the day it happened. */
  limitRefused: number;
  /** Program leads shown real times only because a read failed, counted the day it happened. */
  fallbacks: number;
}

/** The days the page shows and the call window they cover. */
export function programLeadDaysWindow(nowMs: number): { days: string[]; fromIso: string; untilIso: string } {
  const days = placeholderDaysBack(nowMs, PROGRAM_LEAD_DAYS_SHOWN);
  const today = days[0]!;
  const oldest = days[days.length - 1]!;
  // The start of tomorrow, so a call later today is in the read.
  const tomorrow = placeholderDaysBack(placeholderDayStartMs(today) + 36 * 60 * 60_000, 1)[0]!;
  return {
    days,
    fromIso: new Date(placeholderDayStartMs(oldest)).toISOString(),
    untilIso: new Date(placeholderDayStartMs(tomorrow)).toISOString(),
  };
}

const KEPT = new Set(["confirmed", "rescheduled", "completed"]);

export function buildProgramLeadDays(input: {
  days: string[];
  bookings: PlaceholderBookingRow[];
  calls: PlaceholderCallRow[];
  feedNewestMs: number | null;
  outcomes: ProgramLeadOutcomeRow[];
  nowMs: number;
}): ProgramLeadDay[] {
  const rows = new Map<string, ProgramLeadDay>(
    input.days.map((day) => [
      day,
      { day, bookings: 0, onPlaceholder: 0, noRegalCall: 0, notKnownYet: 0, limitRefused: 0, fallbacks: 0 },
    ]),
  );
  for (const b of input.bookings) {
    if (!KEPT.has(b.status)) continue;
    const start = parseStampMs(b.starts_at);
    // parse-ok: a start nobody can read cannot be put on a day; the loader reads
    // timestamptz, so this is a guard, not a path.
    if (start === null) continue;
    const row = rows.get(placeholderCallDay(start));
    if (!row) continue;
    row.bookings += 1;
    if (b.kind !== "staff_placed") continue;
    row.onPlaceholder += 1;
    const verdict = judgePlaceholderCall(b, input.calls, input.feedNewestMs, input.nowMs);
    if (verdict.kind === "unserved") row.noRegalCall += 1;
    // A call with no usable Lead id cannot be matched to a call either way, so it is
    // as unknown as one the feed has not caught up with.
    else if (verdict.kind === "feed-behind" || verdict.kind === "no-lead-id") row.notKnownYet += 1;
  }
  for (const o of input.outcomes) {
    const row = rows.get(o.day);
    if (!row) continue;
    if (o.kind === "times_fallback") row.fallbacks += o.occurrences;
    else if (o.kind === "limit_refused") row.limitRefused += o.occurrences;
  }
  return input.days.map((d) => rows.get(d)!);
}

/** Whether nothing at all happened in the days shown: the empty reading, never the unreadable one. */
export function programLeadDaysEmpty(rows: ProgramLeadDay[]): boolean {
  return rows.every(
    (r) => r.bookings === 0 && r.limitRefused === 0 && r.fallbacks === 0,
  );
}

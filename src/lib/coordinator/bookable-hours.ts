/**
 * The times a coordinator's call may START, in the customer's zone (#4205): the hours
 * for one day (what Sam's script has the coordinator read out when a customer asks for
 * a time outside them), and the days and quarter hour starts the page offers as buttons.
 *
 * Judged by ONE predicate (`isBookableStart`) built from the same rules the booking
 * itself refuses on (`placeBooking`): Pennie's business hours for the whole call
 * (`isOrgOpen`), the customer's calling window on its start (`withinLeadCallingWindow`),
 * the horizon (`withinHorizon`), and nothing at or before now. So the hours shown, the
 * buttons offered and the times accepted cannot disagree (L370); each window is judged
 * in its own zone and never intersected by hand. The hours are scanned a minute at a
 * time over the customer's local day, which is 23 or 25 hours on a clock change day.
 * Pure (relative imports), so `scripts/test-coordinator-lookup.ts` runs it.
 */
import { DateTime } from "luxon";
import { isOrgOpen, type BusinessHoursRules } from "../availability/compute.ts";
import { withinLeadCallingWindow } from "../booking/lead-calling-window.ts";
import { lastHorizonDay, withinHorizon } from "../booking/placed-booking.ts";

export interface StartWindow {
  /** The first start, in the customer's zone (ISO with offset). */
  firstStart: string;
  /** The LAST start, inclusive, in the customer's zone. */
  lastStart: string;
}

export type BookableHours =
  | { ok: true; date: string; windows: StartWindow[] }
  | { ok: false; reason: "date-unreadable" | "hours-unreadable" | "horizon-unreadable" };

/** One day of the page's day row: the customer's local date and every bookable quarter hour start on it. */
export interface OfferedDay {
  date: string;
  /** In the customer's zone (ISO with offset), in order. Empty: the day shows Closed. */
  starts: string[];
}

export type OfferedDays = { ok: true; days: OfferedDay[] } | { ok: false; reason: "hours-unreadable" | "horizon-unreadable" };

export interface StartRules {
  hours: BusinessHoursRules;
  /** The customer's zone. */
  zone: string;
  durationMin: number;
  nowMs: number;
  horizonDays: number;
}

const MINUTE = 60_000;
const QUARTER_HOUR = 15 * MINUTE;

/** THE rule for one start instant, shared by the hours and the buttons. */
function isBookableStart(rules: StartRules, t: number): boolean {
  return (
    t > rules.nowMs &&
    isOrgOpen(rules.hours, t, t + rules.durationMin * MINUTE) &&
    withinLeadCallingWindow(new Date(t).toISOString(), rules.zone) &&
    withinHorizon(rules.hours, t, rules.nowMs, rules.horizonDays)
  );
}

const local = (ms: number, zone: string) => DateTime.fromMillis(ms, { zone }).toISO() ?? "";

export function bookableHoursOn(
  input: StartRules & {
    /** The customer's local day, YYYY-MM-DD. */
    date: string;
  },
): BookableHours {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { ok: false, reason: "date-unreadable" };
  const day = DateTime.fromISO(input.date, { zone: input.zone }).startOf("day");
  if (!day.isValid) return { ok: false, reason: "date-unreadable" };
  const endMs = day.plus({ days: 1 }).toMillis();
  const windows: StartWindow[] = [];
  let runStart: number | null = null;
  let runLast = 0;
  for (let t = day.toMillis(); t < endMs; t += MINUTE) {
    if (isBookableStart(input, t)) {
      if (runStart === null) runStart = t;
      runLast = t;
    } else if (runStart !== null) {
      windows.push({ firstStart: local(runStart, input.zone), lastStart: local(runLast, input.zone) });
      runStart = null;
    }
  }
  if (runStart !== null) windows.push({ firstStart: local(runStart, input.zone), lastStart: local(runLast, input.zone) });
  return { ok: true, date: input.date, windows };
}

/**
 * The page's day row (#4205): the customer's days from their today through the last day
 * Slate offers (`lastHorizonDay`, counted as `withinHorizon` counts open days), each with
 * every quarter hour start `isBookableStart` accepts. A day inside that span with none is
 * kept, so the page can show it Closed; days after the last one with a start are dropped.
 * A US customer is never a calendar day ahead of Pennie's clock, so a customer day past
 * the org's last offered day holds nothing; one more is scanned for safety.
 */
export function offeredDays(input: StartRules): OfferedDay[] {
  const last = lastHorizonDay(input.hours, input.nowMs, input.horizonDays);
  if (last === null) return [];
  const stop = DateTime.fromISO(last, { zone: input.zone }).plus({ days: 1 }).toISODate() ?? last;
  const out: OfferedDay[] = [];
  let day = DateTime.fromMillis(input.nowMs, { zone: input.zone }).startOf("day");
  // Bounded like the horizon walk itself.
  for (let i = 0; i < 366; i++, day = day.plus({ days: 1 })) {
    const date = day.toISODate();
    if (date === null || date > stop) break;
    const endMs = day.plus({ days: 1 }).toMillis();
    const starts: string[] = [];
    for (let t = day.toMillis(); t < endMs; t += QUARTER_HOUR) {
      if (isBookableStart(input, t)) starts.push(local(t, input.zone));
    }
    out.push({ date, starts });
  }
  while (out.length > 0 && out[out.length - 1]!.starts.length === 0) out.pop();
  return out;
}

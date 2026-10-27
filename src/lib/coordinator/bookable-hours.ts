/**
 * The times a coordinator's call may START on one day, in the customer's zone (#4205):
 * what Sam's script has the coordinator read out when a customer asks for a time outside
 * them.
 *
 * Judged by the SAME predicates the booking itself refuses on (`placeBooking`): Pennie's
 * business hours for the whole call (`isOrgOpen`), the customer's calling window on its
 * start (`withinLeadCallingWindow`), the horizon (`withinHorizon`), and nothing at or
 * before now. So the hours shown and the times accepted cannot disagree (L370); each
 * window is judged in its own zone and never intersected by hand. Scanned a minute at a
 * time over the customer's local day, which is 23 or 25 hours on a clock change day.
 * Pure (relative imports), so `scripts/test-coordinator-lookup.ts` runs it.
 */
import { DateTime } from "luxon";
import { isOrgOpen, type BusinessHoursRules } from "../availability/compute.ts";
import { withinLeadCallingWindow } from "../booking/lead-calling-window.ts";
import { withinHorizon } from "../booking/placed-booking.ts";

export interface StartWindow {
  /** The first start, in the customer's zone (ISO with offset). */
  firstStart: string;
  /** The LAST start, inclusive, in the customer's zone. */
  lastStart: string;
}

export type BookableHours =
  | { ok: true; date: string; windows: StartWindow[] }
  | { ok: false; reason: "date-unreadable" | "hours-unreadable" | "horizon-unreadable" };

const MINUTE = 60_000;

export function bookableHoursOn(input: {
  hours: BusinessHoursRules;
  zone: string;
  /** The customer's local day, YYYY-MM-DD. */
  date: string;
  durationMin: number;
  nowMs: number;
  horizonDays: number;
}): BookableHours {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { ok: false, reason: "date-unreadable" };
  const day = DateTime.fromISO(input.date, { zone: input.zone }).startOf("day");
  if (!day.isValid) return { ok: false, reason: "date-unreadable" };
  const endMs = day.plus({ days: 1 }).toMillis();
  const windows: StartWindow[] = [];
  let runStart: number | null = null;
  let runLast = 0;
  const local = (ms: number) => DateTime.fromMillis(ms, { zone: input.zone }).toISO() ?? "";
  for (let t = day.toMillis(); t < endMs; t += MINUTE) {
    const ok =
      t > input.nowMs &&
      isOrgOpen(input.hours, t, t + input.durationMin * MINUTE) &&
      withinLeadCallingWindow(new Date(t).toISOString(), input.zone) &&
      withinHorizon(input.hours, t, input.nowMs, input.horizonDays);
    if (ok) {
      if (runStart === null) runStart = t;
      runLast = t;
    } else if (runStart !== null) {
      windows.push({ firstStart: local(runStart), lastStart: local(runLast) });
      runStart = null;
    }
  }
  if (runStart !== null) windows.push({ firstStart: local(runStart), lastStart: local(runLast) });
  return { ok: true, date: input.date, windows };
}

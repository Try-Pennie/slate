/**
 * Which days Team capacity reports, and which days the booker offers a lead, from one walk
 * (#3949, #4064). Kept out of `team-capacity.ts`, which the page's client bundle carries, so
 * the booker's window rules stay on the server.
 *
 * Pure (luxon and relative imports only), so scripts/test-roster-fill.ts drives it at an
 * injected clock.
 */
import { DateTime } from "luxon";
import { offeredWindowFor } from "../availability/offered-window.ts";
import { windowOnDate, type BusinessHoursException, type BusinessWindow } from "../booking/business-hours.ts";

/**
 * `bookerDays` is `offeredWindowFor`'s own list. `windowDays` is the page's: after the 6 PM
 * cutoff the booker's days start tomorrow, but it still serves whatever today has left, so the
 * page keeps today ahead of them (#3949, Dan, 2026-10-19), on an open day only. Null when the
 * office's week holds no open day to count.
 */
export function capacityDays(
  hours: { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] },
  nowMs: number,
  minNoticeMin: number,
  offeredOpenDays: number,
): { windowDays: string[]; bookerDays: string[] } | null {
  const window = offeredWindowFor(hours, nowMs, minNoticeMin, offeredOpenDays);
  if (!window || window.days.length === 0) return null;
  const today = DateTime.fromMillis(nowMs, { zone: hours.zone });
  const todayIso = today.toISODate()!;
  const todayOpen = windowOnDate(hours, todayIso, today.weekday) !== null;
  const windowDays = todayOpen && window.days[0] > todayIso ? [todayIso, ...window.days] : window.days;
  return { windowDays, bookerDays: window.days };
}

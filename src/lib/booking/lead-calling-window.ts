/**
 * The lead's calling window (#2310): the one judge of whether a call may START
 * at a given instant, on the LEAD's clock.
 *
 * Regal's quiet hours journey (a0c3d620, "Cal.com Call Created in QH") cancels
 * any booked call whose start falls outside 08:00 to 20:00 local to the lead,
 * and files a Rebook Request. Every gate Slate had before this was agent side
 * (the org's business hours, the agent's working hours, the agent's calendar),
 * so a lead in Honolulu could pick 9am Eastern and be dialled at 3am. This is a
 * FOURTH gate, judged in the lead's zone and never intersected with the other
 * windows: the org and agent windows are each judged in their own zone.
 *
 * Whose clock (Dan, 2026-09-24): the zone the booker is using, which is the
 * lead's device zone resolved onto the picker list by default, or whichever zone
 * they pick. Regal derives its zone from the contact's zip or area code, so the
 * two can disagree; the journey stays the backstop and this lowers how often it
 * fires rather than having to be perfect.
 *
 * The window includes its start and excludes its end, and is judged on the
 * call's START (Dan, 2026-09-24): 08:00 may be offered and 07:59 may not; 19:59
 * may and 20:00 may not, matching the journey's `skipFromTime 20:00`. The same
 * everywhere: the journey does not vary it by state.
 *
 * Pure (relative imports only) so `scripts/test-lead-calling-window.ts` runs it
 * under node with no module mocking, and so the booker, the reschedule panels
 * and the server all call this one function rather than three copies of it.
 */
import { DateTime, IANAZone } from "luxon";
import { FALLBACK_ZONE } from "./timezones.ts";

/** Minutes after local midnight: the window is [startMinute, endMinute). */
export const LEAD_CALLING_WINDOW = {
  startMinute: 8 * 60,
  endMinute: 20 * 60,
} as const;

/**
 * The zone a missing or unreadable zone is judged in. It is the booker's own
 * documented fallback (`resolveZone` in `timezones.ts` lands on Eastern), so a
 * request that names no usable zone is judged exactly where the booker would
 * have shown it. Judged, never waved through: an unreadable zone is not a
 * reason to skip the gate.
 */
export const LEAD_CALLING_FALLBACK_ZONE = FALLBACK_ZONE;

/**
 * The zone the lead's window is judged in.
 *
 * A real IANA zone is judged as itself, including one outside the booker's
 * picker list (a direct API caller may send the lead's actual `America/Boise`,
 * and judging that as Eastern would be two hours wrong). The booker only ever
 * sends a zone from its list, so for it this is the displayed zone exactly and
 * the client filter and the server check cannot disagree. Anything else falls
 * back to `LEAD_CALLING_FALLBACK_ZONE`.
 */
export function leadCallingZone(zone: string | null | undefined): string {
  if (zone && IANAZone.isValidZone(zone)) return zone;
  return LEAD_CALLING_FALLBACK_ZONE;
}

/**
 * Whether a call starting at `startIso` starts inside the lead's calling window
 * in `zone`. An unreadable start is outside: this gate must never fail open.
 */
export function withinLeadCallingWindow(startIso: string, zone: string | null | undefined): boolean {
  const local = DateTime.fromISO(startIso, { setZone: false }).setZone(leadCallingZone(zone));
  if (!local.isValid) return false;
  const minute = local.hour * 60 + local.minute;
  return minute >= LEAD_CALLING_WINDOW.startMinute && minute < LEAD_CALLING_WINDOW.endMinute;
}

/**
 * The times a lead in `zone` may be offered, and the ones set aside, both in
 * their original order. The shared slot picker keeps the set aside ones so it
 * can tell a day with nothing free from a day whose free times are all outside
 * the lead's hours, and say which.
 */
export function splitByLeadCallingWindow(
  slots: readonly string[],
  zone: string | null | undefined,
): { offered: string[]; outside: string[] } {
  const offered: string[] = [];
  const outside: string[] = [];
  for (const iso of slots) (withinLeadCallingWindow(iso, zone) ? offered : outside).push(iso);
  return { offered, outside };
}

/** "8 AM" / "8 PM" / "8:30 AM", from a minute of the day. */
function clockLabel(minuteOfDay: number): string {
  const h24 = Math.floor(minuteOfDay / 60) % 24;
  const m = minuteOfDay % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`} ${h24 < 12 ? "AM" : "PM"}`;
}

/**
 * The window's bounds as a lead reads them, derived from the constant so copy
 * naming the hours cannot drift from the rule that enforces them.
 */
export function callingWindowLabel(): { from: string; to: string } {
  return {
    from: clockLabel(LEAD_CALLING_WINDOW.startMinute),
    to: clockLabel(LEAD_CALLING_WINDOW.endMinute),
  };
}

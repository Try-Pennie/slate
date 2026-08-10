/**
 * How far away a booking is, in words, for the manage page's heading (#1338).
 *
 * Computed from the booking's time at RENDER, never stamped: a lead who
 * reschedules must see the new distance, and someone who opens the link days
 * later from a calendar reminder must see today's answer rather than the one
 * that was true when the email went out.
 *
 * Pure (relative imports only) so `scripts/test-booking-countdown.ts` runs it
 * with a pinned clock and no mocking.
 */
import { DateTime } from "luxon";

/** Spelled out to ten, then figures: "in three days", "in 14 days". */
const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/**
 * "today", "tomorrow", "in three days", or null when the call is not ahead.
 *
 * Null rather than a negative phrase: a booking whose time has passed is still
 * `confirmed` until the completion sweep runs, so this is reachable, and "in
 * minus two days" is worse than a heading that simply carries the advisor's
 * name. The caller drops the countdown on null.
 *
 * The difference is counted in CALENDAR days in the viewer's zone, so a call at
 * 9am tomorrow reads "tomorrow" whether it is 8pm or 2am now, which is how a
 * person reads their own diary.
 */
export function countdownPhrase(
  startsAtIso: string,
  nowMs: number,
  zone: string,
): string | null {
  const start = DateTime.fromISO(startsAtIso).setZone(zone);
  const now = DateTime.fromMillis(nowMs).setZone(zone);
  if (!start.isValid || !now.isValid) return null;
  const days = Math.round(
    start.startOf("day").diff(now.startOf("day"), "days").days,
  );
  if (days < 0) return null;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${WORDS[days] ?? String(days)} days`;
}

/**
 * The first name to greet an advisor by, or null when there is no name to use.
 *
 * Never a placeholder: the surfaces that show it must render no name rather than
 * a wrong or stale one (L75), and a booking can be reassigned between the email
 * going out and the link being opened.
 */
export function advisorFirstName(fullName: string | null): string | null {
  const first = (fullName ?? "").trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : null;
}

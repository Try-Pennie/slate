import { DateTime } from "luxon";
import { parseStampMs } from "@/lib/date/stamp";
import { formatClockTime, formatLongDate } from "@/lib/date/parse";

/**
 * What the agent page says about a flip the roster sync is still waiting to make
 * (#2078), from `users.bookable_pending_since`.
 *
 * Every reason the activation gate keeps a mark for is about the Google calendar
 * (unreachable, never given Calendar, unreadable, slow, or busy in another job): a
 * Redistribute refusal clears the mark instead of keeping it. So "Slate cannot
 * read their Google calendar yet" is true of every row that reaches this line,
 * which is the "why" the issue asked the page to show.
 *
 * The date is in the business zone and says so, because the page is rendered on a
 * server whose clock is UTC (L589). An unreadable stamp drops the date rather than
 * printing "Invalid DateTime": the waiting is still true.
 */
export function pendingFlipSentence(sinceIso: string, zone = "America/New_York"): string {
  const ms = parseStampMs(sinceIso);
  const at = ms === null ? null : DateTime.fromMillis(ms, { zone });
  const day = at ? formatLongDate(at) : null;
  const time = at ? formatClockTime(at) : null;
  const when = day && time ? ` since ${day} at ${time} ET` : "";
  return `Waiting to become bookable${when}. Slate cannot read their Google calendar yet, so the roster sync tries again every hour.`;
}

/** The button that settles the wait without making them bookable. */
export const CLEAR_PENDING_FLIP_LABEL = "Stop trying to make them bookable";

export type CalendarMenuStatus = "na" | "connected" | "degraded" | "disconnected";

export interface CalendarHeaderStatus {
  /** What the account-menu calendar indicator shows. */
  menu: CalendarMenuStatus;
  /** Whether to show the urgent "your availability may be wrong" banner. */
  urgent: boolean;
}

/**
 * The header calendar-status decision (#87), a pure function so the false-alarm
 * boundary is unit-tested rather than reasoned about per render.
 *
 * The old logic keyed the urgent red banner off "has a LIVE push-watch". But a
 * push watch lapses and auto-renews on the cron, and the 1-min backstop sync
 * covers an agent even with no live watch, so a lapse alone is a false alarm.
 * The honest states are:
 *   - `connected`: a live push-watch (real-time sync).
 *   - `degraded`: no live watch but a calendar row exists, so the every-minute
 *     backstop still syncs them; push is just delayed. NOT urgent.
 *   - `disconnected`: no calendar row at all, so we can't sync them; a bookable
 *     agent here can genuinely drift and double-book. Urgent.
 * `urgent` (the loud banner) is reserved for the last case on a bookable agent, so
 * the banner stays trustworthy.
 */
export function calendarHeaderStatus(input: {
  /** We actually looked up the calendars (a userId is present and not OOO-only). */
  checked: boolean;
  bookable: boolean;
  /** An `agent_calendars` row exists (so the backstop sync covers them). */
  hasCalendars: boolean;
  /** A currently-live push-watch channel. */
  hasLiveWatch: boolean;
}): CalendarHeaderStatus {
  if (!input.checked) return { menu: "na", urgent: false };
  if (input.hasLiveWatch) return { menu: "connected", urgent: false };
  if (input.hasCalendars) return { menu: "degraded", urgent: false };
  return { menu: "disconnected", urgent: input.bookable };
}

/**
 * Hours of the day an alert may post in, for an alert nobody needs at night.
 *
 * Dan, 2026-10-26, on the calendars filling up notice posting at 1:23 AM: "this alert
 * looks good but I only want it to post during business hours from 9am - 6pm". He then
 * moved the start to 8 AM the same day, preferring a post slightly early to one slightly
 * late. So it posts from 8 AM up to 6 PM New York time, every day of the week, weekends
 * included, judged on the New York clock so the window follows daylight saving.
 *
 * Named posting hours, not business hours: in Slate "business hours" are the org's
 * stored opening times (`src/lib/booking/business-hours.ts`), which differ by weekday
 * and close on Sunday; this is a fixed window about when people read Slack.
 *
 * The rule only answers whether now is inside. What an alert does outside is its
 * owner's: the calendars filling up notice (`src/lib/monitor/roster-fill.ts`) neither
 * posts nor clears, so nothing is recorded as sent and the first tick inside the window
 * judges that morning's reading afresh.
 *
 * Pure (luxon and relative imports only), so scripts/test-posting-hours.ts runs it natively.
 */
import { DateTime } from "luxon";
import { BUSINESS_ZONE } from "../booking/business-hours.ts";

export interface PostingHours {
  /** The IANA zone the window is read on. */
  zone: string;
  /** First minute of the day inside the window, from midnight. */
  fromMinute: number;
  /** First minute of the day past the window, from midnight: the window runs up to it. */
  toMinute: number;
}

/** 8 AM up to 6 PM New York time, every day (Dan, 2026-10-26). */
export const DAYTIME_POSTING_HOURS: PostingHours = {
  zone: BUSINESS_ZONE,
  fromMinute: 8 * 60,
  toMinute: 18 * 60,
};

/** True when `nowMs` falls inside `hours`, read on the window's own clock. */
export function withinPostingHours(nowMs: number, hours: PostingHours): boolean {
  const local = DateTime.fromMillis(nowMs, { zone: hours.zone });
  if (!local.isValid) return false;
  const minute = local.hour * 60 + local.minute;
  return hours.fromMinute <= minute && minute < hours.toMinute;
}

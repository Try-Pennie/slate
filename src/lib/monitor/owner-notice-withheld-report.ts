/**
 * Owner reassign notices that never reached the sales side, said once a week (#2440).
 *
 * The notice step (#2372) completes without posting when no handoff channel is set,
 * and since #2440 records that on the outbox step (`withheld`, see
 * src/lib/booking/owner-notice-withheld.ts). This reads that record back: a count of
 * the outbox rows from the last seven days whose notice step was withheld for want of
 * a channel, and an INFO whisper naming it.
 *
 * Info, not a page, and never resolved:
 *  - Nothing here is broken in a way a person must fix at once. The reassign itself
 *    happened and is in `booking_events`; what is missing is a courtesy notice, and a
 *    handoff somebody must act on already pages while the channel is unset (#2367).
 *  - It reports a count over a trailing week, not a state that ends, so an all clear
 *    would say that a week which is over is over.
 *
 * Only the `no_handoff_channel` reason is counted. A deployment with no Slack token
 * records `no_slack_token` on the step as well, but a report about that could only be
 * delivered by the Slack that is not there, so the record is for the warehouse and
 * for a person reading the row.
 *
 * A count that cannot be read THROWS, so the monitor step's boundary records it and
 * its failure streak pages if it lasts: an unreadable count is not a week with
 * nothing withheld.
 *
 * No `@/` imports, so scripts/test-owner-notice-withheld-report.ts drives it natively.
 */
import type { ThrottledNotify } from "./alert-deps";

/** The info key, for the sender, the catalog and the preview. */
export const OWNER_NOTICE_WITHHELD_KEY = "owner_notice_withheld";

const DAY_MS = 24 * 60 * 60_000;

/** How far back the count reaches. Delivered outbox rows are kept 30 days, so a
 *  week is always inside what the table still holds. */
export const OWNER_NOTICE_WITHHELD_WINDOW_MS = 7 * DAY_MS;

/** Said at most once a week: the cadence the issue asked for, and the window, so
 *  consecutive reports never count the same notice twice. */
export const OWNER_NOTICE_WITHHELD_COOLDOWN_MS = 7 * DAY_MS;

export function formatOwnerNoticeWithheldReport(input: {
  count: number;
  windowDays: number;
  settingsUrl: string;
}): string {
  const one = input.count === 1;
  const notices = one ? "owner reassign notice was" : "owner reassign notices were";
  return (
    `${input.count} ${notices} not posted to the sales side in the last ${input.windowDays} days, ` +
    `because no handoff channel was set when ${one ? "the reassign" : "each reassign"} happened. ` +
    (one
      ? `The reassign itself went through and is in its booking history; only the notice is missing. `
      : `The reassigns themselves went through and each one is in its booking history; only the notice is missing. `) +
    `The handoff channel is set on ${input.settingsUrl}.`
  );
}

export type OwnerNoticeWithheldResult = { status: "none"; count: 0 } | { status: "reported"; count: number };

export async function runOwnerNoticeWithheldReport(deps: {
  nowMs: number;
  /** Outbox rows created since this instant whose notice was withheld for want of a
   *  channel. THROWS on a failed read. */
  countWithheld: (sinceIso: string) => Promise<number>;
  notify: ThrottledNotify<unknown>;
  settingsUrl: string;
}): Promise<OwnerNoticeWithheldResult> {
  const sinceIso = new Date(deps.nowMs - OWNER_NOTICE_WITHHELD_WINDOW_MS).toISOString();
  const count = await deps.countWithheld(sinceIso);
  if (count <= 0) return { status: "none", count: 0 };
  await deps.notify(
    OWNER_NOTICE_WITHHELD_KEY,
    OWNER_NOTICE_WITHHELD_COOLDOWN_MS,
    formatOwnerNoticeWithheldReport({
      count,
      windowDays: Math.round(OWNER_NOTICE_WITHHELD_WINDOW_MS / DAY_MS),
      settingsUrl: deps.settingsUrl,
    }),
  );
  return { status: "reported", count };
}

/**
 * Paging for external double-book clashes (#316, #2905). Pure apart from the
 * injected notify, so a node test drives it.
 */
import type { ExternalCollision } from "@/lib/google/collision";
import { externalDoubleBookAlert } from "@/lib/notify/misc-alert-copy";
import { log } from "@/lib/log";
import type { ThrottledNotify } from "@/lib/monitor/alert-deps";

/**
 * One page per CLASH. The message names one call and one outside event, and a
 * cooldown keyed coarser than that lets a second clash sit silent behind the first
 * page, which then reads as the whole picture (L707). Keyed by the advisor, a
 * second call's clash was silenced; keyed by the call alone, a second outside
 * event on it, or the call moved onto another clash, would have been.
 *
 * The booking id LEADS the key, because the retention prune reads it from there
 * to reap the row once the call has passed.
 */
export function doubleBookAlertKey(c: ExternalCollision): string {
  // A Google event id carries no colon. One with no id is told apart by its window.
  const event = c.gcalEventId ?? `w${c.eventStartMs}-${c.eventEndMs}`;
  return `external_double_book:${c.bookingId}:${event}:${c.bookingStartMs}`;
}

/**
 * How long one call's clash stays quiet after it is paged. Sync sees a
 * persisting clash every minute, so a short cooldown would re-page the same call
 * all day (L36); a day means an unresolved clash on a future call is raised again
 * tomorrow rather than never.
 */
export const DOUBLE_BOOK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface DoubleBookPagingDeps {
  notify: ThrottledNotify;
  bookingUrl: (bookingId: string) => string;
}

export async function pageExternalCollisions(
  email: string,
  collisions: ExternalCollision[],
  deps: DoubleBookPagingDeps,
): Promise<void> {
  for (const c of collisions) {
    // Each call is its own failure boundary: one refused send must not leave the
    // advisor's other clashes unpaged (L73).
    try {
      await deps.notify(
        doubleBookAlertKey(c),
        DOUBLE_BOOK_COOLDOWN_MS,
        externalDoubleBookAlert(email, {
          bookingUrl: deps.bookingUrl(c.bookingId),
          callStart: new Date(c.bookingStartMs).toISOString(),
          eventStart: new Date(c.eventStartMs).toISOString(),
          eventEnd: new Date(c.eventEndMs).toISOString(),
        }),
      );
    } catch (err) {
      log.error("sync", { msg: "double-book page failed", booking_id: c.bookingId }, err);
    }
  }
}

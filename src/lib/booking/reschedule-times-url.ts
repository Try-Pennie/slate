/**
 * Where a surface offering MOVE times reads them from (#2827).
 *
 * A booking made through an advisor's own link (#2073, `kind = 'agent_link'`) can
 * only be moved to a time that same advisor can take: the reschedule keeps the
 * agent or refuses (`rescheduleBooking`, orchestration.ts). So its move times are
 * that advisor's, served by the same narrowed compute the advisor link itself
 * reads (`namedAgentTimes`). A routed booking re-routes within its bucket when its
 * agent cannot take the new time, so its move times are the bucket's pool, read
 * exactly as they always were.
 *
 * ONE predicate decides which, used by the server (which refuses the narrowed read
 * for a routed booking) and by every surface that builds a URL: the manage page,
 * the booker's move of a call the lead already has, and the admin move. A client
 * module: no server import may reach this file.
 */

import type { BookingKind } from "@/lib/db/types";

export type RescheduleTimesFrom = "pool" | "advisor";

export function rescheduleTimesFrom(booking: { kind: BookingKind }): RescheduleTimesFrom {
  return booking.kind === "agent_link" ? "advisor" : "pool";
}

/**
 * The lead's read, keyed on the manage token. The token is what already lets its
 * holder move and cancel this booking, so it unlocks its own advisor's times and
 * nothing else: it names no advisor and no link, and cannot be pointed at one.
 */
export function leadRescheduleTimesUrl(
  from: RescheduleTimesFrom,
  target: { bucketCode: string; manageToken: string },
): string {
  return from === "advisor"
    ? `/api/availability?booking=${encodeURIComponent(target.manageToken)}`
    : `/api/availability?bucket=${encodeURIComponent(target.bucketCode)}`;
}

/**
 * The admin move's read. An advisor booking goes through the staff route keyed on
 * the booking id, so no lead credential is ever put in a staff page. Null when
 * there is nothing to read (a routed booking with no bucket).
 */
export function adminRescheduleTimesUrl(
  from: RescheduleTimesFrom,
  target: { bucketCode: string | null; bookingId: string },
): string | null {
  if (from === "advisor") return `/api/admin/bookings/${encodeURIComponent(target.bookingId)}/availability`;
  return target.bucketCode ? `/api/availability?bucket=${encodeURIComponent(target.bucketCode)}` : null;
}

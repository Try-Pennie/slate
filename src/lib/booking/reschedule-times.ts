import {
  namedAgentTimes,
  readTimesWindow,
  UNREADABLE_WINDOW_BODY,
  type NamedAgentTimesBody,
  type NamedAgentTimesDeps,
} from "@/lib/agent-link/availability";
import { RESCHEDULE_COPY } from "@/lib/booking/manage-copy";
import { rescheduleTimesFrom } from "@/lib/booking/reschedule-times-url";
import { RESCHEDULE_TIMES_UNAVAILABLE_CODE } from "@/lib/booking/reschedule-times-refusal";
import type { BookingKind } from "@/lib/db/types";

export { RESCHEDULE_TIMES_UNAVAILABLE_CODE };

/**
 * The times an advisor link booking may be MOVED to (#2827).
 *
 * The reschedule of such a booking keeps its advisor or refuses (#2073), so its
 * move times are that one advisor's, computed by `namedAgentTimes`: the SAME
 * function the advisor link's own read runs, narrowed through the same resolver.
 * What the picker offers and what the move accepts therefore rest on one compute,
 * not on two copies that could drift.
 *
 * Only an advisor link booking is served. A routed booking's move times are its
 * bucket's pool (`/api/availability?bucket=`), because its move re-routes within
 * the bucket; serving it a narrowed read here would under-offer, so it is refused
 * rather than guessed at. Which is which is `rescheduleTimesFrom`, the one
 * predicate every surface also uses to build its URL.
 *
 * The caller is authorised by the key it reaches the booking with (the manage
 * token on the public route, a staff session on the admin one), and that key
 * unlocks only this booking's own advisor: the request names no advisor, so it
 * cannot be pointed at another one. Every refusal is one body whatever the cause.
 */

/** The slice of a booking this needs, read by whichever key the caller holds. */
export interface RescheduleTimesBooking {
  status: string;
  kind: BookingKind;
  assignedUserId: string | null;
  bucketCode: string;
}

export interface RescheduleTimesDeps<K = string> extends NamedAgentTimesDeps {
  /** The booking the key names, or null when it names none. A read that FAILS
   *  throws: "no booking" is a final answer and a failed read is not one. */
  loadBooking(key: K): Promise<RescheduleTimesBooking | null>;
  /** The refusal cause, for the log only (never the key). */
  logRefusal(why: string): void;
}

export type RescheduleTimesReply =
  | { status: 200; body: NamedAgentTimesBody }
  | { status: 400 | 404; body: { error: string; code: string } };

function unavailableReply(): RescheduleTimesReply {
  return { status: 404, body: { error: RESCHEDULE_COPY.unavailable, code: RESCHEDULE_TIMES_UNAVAILABLE_CODE } };
}

export async function bookingRescheduleTimes<K>(
  key: K,
  query: { from: string | null; to: string | null },
  nowMs: number,
  deps: RescheduleTimesDeps<K>,
): Promise<RescheduleTimesReply> {
  const window = readTimesWindow(query);
  if (window === "unreadable") return { status: 400, body: UNREADABLE_WINDOW_BODY };

  const booking = await deps.loadBooking(key);
  const refuse = (why: string) => {
    deps.logRefusal(why);
    return unavailableReply();
  };
  if (!booking) return refuse("booking_not_found");
  // The same two terminal states the reschedule itself refuses on.
  if (booking.status === "cancelled" || booking.status === "completed") return refuse("booking_not_active");
  if (rescheduleTimesFrom(booking) !== "advisor") return refuse("not_an_advisor_booking");
  // An advisor booking nobody is on can only ever be refused by the move, so it
  // is offered nothing rather than a pool it can never land in.
  if (!booking.assignedUserId) return refuse("no_advisor");

  const times = await namedAgentTimes(
    { bucketCode: booking.bucketCode, agentUserId: booking.assignedUserId },
    window,
    nowMs,
    deps,
  );
  if (!times) return refuse("bucket_unresolvable");
  return { status: 200, body: times };
}

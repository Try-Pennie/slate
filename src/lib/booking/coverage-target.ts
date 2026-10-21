import { VerifyUnavailableError, type RerouteTarget } from "@/lib/booking/orchestration";
import { bookingWindow, type SelectionOutcome } from "@/lib/booking/core";
import type { Booking, Bucket, EventType } from "@/lib/db/types";
import { log } from "@/lib/log";

/**
 * How many times one selection may find its pick on approved time off and search again
 * without them. The booker's own read already leaves out an advisor whose time off reached
 * the calendar cache, so a second pass is the rare case of a Google write that failed and a
 * cache that has not caught up; a third is stranger still. Past this the item is retried on
 * a later tick rather than searched for ever on one.
 */
const MAX_TIME_OFF_RESEARCHES = 3;

/** The side effects coverage target selection needs; `service.ts` wires the real ones. */
export interface CoverageTargetDeps {
  /**
   * Reroute's own search (`findRerouteTarget`), bound to the live deps: the booker's round
   * robin over the cached free advisors (business hours, working hours, the buffered
   * calendar, the daily cap, Reroute holds and the Low rule), then the LIVE verify on book
   * over the buffered window. `excludeUserIds` are never offered.
   */
  findTarget(
    booking: Booking,
    requested: { bucket: Bucket; eventType: EventType },
    excludeUserIds: readonly string[],
  ): Promise<RerouteTarget>;
  /**
   * Which of `userIds` have APPROVED time off overlapping [startIso, endIso).
   *
   * Authoritative, and deliberately not derived from Google or from `busy_blocks`
   * (#1236): see the note in `selectCoverageReassignTarget`. Throwing is the correct
   * behaviour on a read error; the caller turns it into a retry rather than guessing.
   */
  userIdsOnApprovedTimeOff(userIds: string[], startIso: string, endIso: string): Promise<Set<string>>;
}

/**
 * Pick a covering advisor for one booking being moved off an out agent (#972), by the
 * SAME rule the booker and Reroute use to answer "who can take this call" (#3308).
 *
 * Until #3308 the sweep had a selection of its own: every member of the booking's pool in
 * round robin order, judged only by live Google and the daily cap. Reroute and the booker
 * judge a fixed time through `roundRobinCandidates` first, which also applies the org's
 * business hours, the advisor's working hours, Reroute holds and the Low rule, and only
 * then ask Google. So the sweep could hand a call to an advisor who was off shift (an empty
 * evening calendar reads as free) or one an admin was holding for a reroute, and the two
 * paths could disagree about the same advisor at the same time (L342, L261). Both pad the
 * call by the event type's buffers the same way (`bufferedWindow`), and both ask Google the
 * same question, so neither one ever found someone the other could not: the 2026-10-05 and
 * 2026-10-12 strandings were real full slots (see #3308). Now there is one rule.
 *
 * The out agent is never kept. Reroute's search keeps a booking's current advisor when
 * they still fit, which is right for a bucket correction and wrong here: they are the
 * reason the sweep exists, and an agent swept off their own day (a manager covering an
 * active agent) still fits on paper. So the booking is searched as if nobody held it, with
 * the out agent excluded, and a keep can only mean nobody else anywhere.
 *
 * Approved time off is checked SEPARATELY, and it has to be (#1236). The booker reads time
 * off from the calendar: the event `runPostApproval` writes, or the slate busy block it
 * falls back to when Google refuses. Both can lag (a cache not yet refreshed, a write that
 * failed outright), and placing a call swept off one absent agent onto a second absent one
 * is #1219 again. `ooo_requests` does not depend on Google having accepted anything, so a
 * pick on approved time off is excluded and the search runs again.
 *
 * Only the booking's OWN bucket is placed into here. A target the search found on a lower
 * rung of the tier ladder is reported as nobody in this pool: moving a call into another
 * bucket rides the Reroute swap and its hold, which is #3485's change, not this one.
 *
 * `anyUnverified` is true when the answer could not be known: a live verify outage, an
 * unreadable time off check, or any other failed read. The bulk engine retries those and
 * settles them `failed` only after its attempt cap, so one outage never strands a call as
 * `unplaceable` and never places it on somebody nobody could check.
 */
export async function selectCoverageReassignTarget(
  ctx: { booking: Booking; bucket: Bucket; eventType: EventType },
  deps: CoverageTargetDeps,
): Promise<SelectionOutcome> {
  const { booking, bucket, eventType } = ctx;
  const { startIso, endIso } = bookingWindow(booking.starts_at, eventType.duration_min);
  const unassigned: Booking = { ...booking, assigned_user_id: null };
  const exclude: string[] = booking.assigned_user_id ? [booking.assigned_user_id] : [];

  for (let pass = 0; pass <= MAX_TIME_OFF_RESEARCHES; pass++) {
    let target: RerouteTarget;
    try {
      target = await deps.findTarget(unassigned, { bucket, eventType }, exclude);
    } catch (err) {
      if (!(err instanceof VerifyUnavailableError)) {
        // A failed read behind the search (the pool, the cache, the holds). Retried like an
        // outage rather than thrown, so one bad read cannot stop the drain's whole tick.
        log.error("coverage-target", { msg: "coverage target search failed; the item will retry", booking_id: booking.id }, err);
      }
      return { assignment: null, anyUnverified: true };
    }
    if (target.outcome !== "move-in-requested") {
      // Keep outcomes need somebody to keep and the booking was searched unassigned, so
      // they mean nobody anywhere; a cascaded move means nobody in the booking's own pool.
      return { assignment: null, anyUnverified: false };
    }
    let away: Set<string>;
    try {
      away = await deps.userIdsOnApprovedTimeOff([target.userId], startIso, endIso);
    } catch (err) {
      // FAIL CLOSED, as an outage rather than as nobody free: never place a call on an
      // advisor whose absence could not be checked, and never settle it unplaceable for it.
      log.error("coverage-target", { msg: "approved time off could not be read; the item will retry", booking_id: booking.id }, err);
      return { assignment: null, anyUnverified: true };
    }
    if (!away.has(target.userId)) {
      return { assignment: { userId: target.userId, email: target.email }, anyUnverified: false };
    }
    exclude.push(target.userId);
  }
  log.warn("coverage-target", {
    msg: "every pick was on approved time off the calendar did not show; the item will retry",
    booking_id: booking.id,
    excluded: exclude.length,
  });
  return { assignment: null, anyUnverified: true };
}

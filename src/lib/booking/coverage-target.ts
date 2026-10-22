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

/**
 * Where a move that dropped down the tier ladder lands (#3485 Part 1): the lower rung's
 * bucket and event type, and how many rungs were dropped. Absent for a move in the
 * booking's own bucket, which stays a plain reassign.
 */
export interface CoveragePlacement {
  bucket: Bucket;
  eventType: EventType;
  rungsDropped: number;
  /** The advisor the move holds, the same one as the selection's assignment. */
  advisorUserId: string;
}

/**
 * Why nobody could take the call, when the measured reason is the gap kept clear around
 * it (#3485): `advisors` in the booking's own pool looked free for the call itself, by the
 * booker's own predicate over the calendar cache, but not once the event type's buffers
 * were added. A cache reading, so an upper bound on who Google would also have found free.
 */
export interface GapOnlyReason {
  advisors: number;
  beforeMin: number;
  afterMin: number;
}

/** A coverage pick, and where it lands when that is a lower rung's bucket. */
export interface CoverageSelection extends SelectionOutcome {
  placement?: CoveragePlacement;
  /** Set only on an unplaceable outcome whose measured reason is the gap; absent otherwise. */
  gapOnly?: GapOnlyReason;
}

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
  /**
   * Who in the booking's own pool the round robin finds free at its time with the event
   * type's buffers taken off, `excludeUserIds` left out: the call alone, never the gap
   * around it. Cache only (no Google), and asked only once nobody could be placed.
   */
  freeForBareCall(
    booking: Booking,
    requested: { bucket: Bucket; eventType: EventType },
    excludeUserIds: readonly string[],
  ): Promise<string[]>;
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
 * The search walks the tier ladder as the booker does (#3485 Part 1), so a call nobody in
 * its own pool can take goes to the first lower rung with somebody free, exactly where a
 * new lead at that time would have gone. Such a pick carries its `placement`, because a
 * move into another bucket rides Reroute's hold and bucket aware swap
 * (`coverage-cascade.ts`). A named advisor link (`agent_link`) never drops a rung: the
 * lead chose that advisor's link, and the swap refuses to move one across buckets.
 *
 * `anyUnverified` is true when the answer could not be known: a live verify outage, an
 * unreadable time off check, or any other failed read. The bulk engine retries those and
 * settles them `failed` only after its attempt cap, so one outage never strands a call as
 * `unplaceable` and never places it on somebody nobody could check.
 */
export async function selectCoverageReassignTarget(
  ctx: { booking: Booking; bucket: Bucket; eventType: EventType },
  deps: CoverageTargetDeps,
): Promise<CoverageSelection> {
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
    // Keep outcomes need somebody to keep and the booking was searched unassigned, so they
    // mean nobody anywhere on the ladder.
    if (target.outcome !== "move-in-requested" && target.outcome !== "move-cascaded") {
      return nobodyFree(deps, unassigned, { bucket, eventType }, exclude);
    }
    const cascaded = target.outcome === "move-cascaded";
    if (cascaded && booking.kind === "agent_link") return nobodyFree(deps, unassigned, { bucket, eventType }, exclude);
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
      const assignment = { userId: target.userId, email: target.email };
      if (!cascaded) return { assignment, anyUnverified: false };
      return {
        assignment,
        anyUnverified: false,
        placement: {
          bucket: target.bucket,
          eventType: target.eventType,
          rungsDropped: target.rungsDropped,
          advisorUserId: target.userId,
        },
      };
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

/**
 * The unplaceable outcome, carrying the gap as its reason when that is what was measured
 * (#3485): somebody in the booking's own pool was free for the call itself. Only a reason,
 * never a placement: a call back to back with another is still refused, as the booker
 * refuses it, until a policy says otherwise. A count that cannot be read leaves the reason
 * unmeasured rather than claiming nobody was free for the call (L11).
 */
async function nobodyFree(
  deps: CoverageTargetDeps,
  booking: Booking,
  requested: { bucket: Bucket; eventType: EventType },
  exclude: readonly string[],
): Promise<CoverageSelection> {
  const { buffer_before_min: beforeMin, buffer_after_min: afterMin } = requested.eventType;
  if (beforeMin === 0 && afterMin === 0) return { assignment: null, anyUnverified: false };
  try {
    const free = await deps.freeForBareCall(booking, requested, exclude);
    const advisors = free.filter((id) => !exclude.includes(id)).length;
    if (advisors === 0) return { assignment: null, anyUnverified: false };
    return { assignment: null, anyUnverified: false, gapOnly: { advisors, beforeMin, afterMin } };
  } catch (err) {
    log.warn("coverage-target", { msg: "could not count who was free for the call alone; the reason is left unmeasured", booking_id: booking.id }, err);
    return { assignment: null, anyUnverified: false };
  }
}

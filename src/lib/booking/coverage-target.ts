import { DateTime } from "luxon";

import { isUnderDailyCap, type WorkingRule } from "@/lib/availability/compute";
import { bookingWindow, bufferedWindow, selectReassignTarget, type SelectionOutcome, type VerifyResult } from "@/lib/booking/core";
import type { Booking, Bucket, EventType } from "@/lib/db/types";

/**
 * Verify-on-book wave size for coverage target selection: how many ordered
 * candidates to live-check per batched free/busy round-trip. Matches the booker's
 * wave sizing (Google's 20-calendar freeBusy cap, #167) so a wave of
 * single-calendar agents is one round-trip.
 */
const COVERAGE_VERIFY_WAVE_SIZE = 20;

/** The side effects coverage target selection needs; `service.ts` wires the real ones. */
export interface CoverageTargetDeps {
  /**
   * The bucket's eligible agent ids in round-robin (equal-share) order, fallback
   * applied. The real impl walks `resolveRouting`'s ordered `eligibleIds`. This
   * is only the ORDER; freeness is verified live below, never from the cache.
   */
  orderedEligibleIds(bucket: Bucket): Promise<string[]>;
  /** Batched userId -> email resolver for a verify wave (skips emailless). */
  loadEmails(userIds: string[]): Promise<Map<string, string>>;
  /** LIVE verify-on-book free check over [startIso, endIso), not the cache. */
  verifyFree(emails: string[], startIso: string, endIso: string, ids?: ReadonlyMap<string, string>): Promise<VerifyResult>;
  /** One agent's working-hours schedule (timezone + rules), for the cap's local day. */
  agentWorkingHours(userId: string): Promise<{ timezone: string; rules: WorkingRule[] }>;
  /**
   * Which of `userIds` have APPROVED time off overlapping [startIso, endIso).
   *
   * Authoritative, and deliberately not derived from Google or from `busy_blocks`
   * (#1236): see the note in `selectCoverageReassignTarget` for why neither can be
   * trusted for this. Throwing is the correct behavior on a read error; the caller
   * turns it into a retry rather than guessing.
   */
  userIdsOnApprovedTimeOff(
    userIds: string[],
    startIso: string,
    endIso: string,
  ): Promise<Set<string>>;
  /** One agent's active booking starts (epoch-ms) in [fromIso, toIso), excluding a booking. */
  agentActiveBookingStartsMs(
    userId: string,
    fromIso: string,
    toIso: string,
    excludeBookingId: string,
  ): Promise<number[]>;
}

/**
 * Pick a covering agent for one booking being reassigned off an out agent (#972):
 * the first agent GENUINELY free at the booking's original time AND under their
 * daily cap, in round-robin order, excluding the out agent (the booking's current
 * `assigned_user_id`). Returns a null assignment when unplaceable at that time.
 *
 * The reassign swap rides `allow_double_book`, so freeness is the LIVE
 * verify-on-book path over the booking's exact original window, never the
 * `busy_blocks` cache, which can be stale mid-churn and silently double-book the
 * covering agent (the red-team's critical catch). The daily-cap check reads the
 * agent's authoritative per-local-day count so that, moved one booking at a time,
 * each committed move is reflected in the next pick's count (#973's serialization).
 * `anyUnverified` distinguishes a genuine no-coverage miss from a verify outage so
 * the engine can report vs retry (see `selectReassignTarget`).
 *
 * Approved time off is checked SEPARATELY from freeness, and it has to be (#1236).
 * Live Google is the only freeness signal here, so an agent on approved leave is
 * excluded only because `runPostApproval` managed to put an event on their calendar.
 * That write is best-effort: when it fails, the OOO flow falls back to a
 * slate-source `busy_blocks` row, which availability can see and this selection
 * cannot, by design. Two agents off the same week plus one failed Google write was
 * therefore enough to place every booking swept off the first onto the second, who
 * was also away, which is #1219 recreated by the fix for #1219. `ooo_requests` is
 * the one signal that does not depend on Google having accepted anything.
 */
export async function selectCoverageReassignTarget(
  ctx: { booking: Booking; bucket: Bucket; eventType: EventType },
  deps: CoverageTargetDeps,
): Promise<SelectionOutcome> {
  const { booking, bucket, eventType } = ctx;
  const { startIso, endIso } = bookingWindow(booking.starts_at, eventType.duration_min);
  const ordered = await deps.orderedEligibleIds(bucket);

  // The out agent is excluded from the time-off read as well as from selection:
  // they are the reason this sweep exists, so asking whether they are away is a
  // wasted row. `selectReassignTarget` still excludes them from placement.
  const askable = ordered.filter((id) => id !== booking.assigned_user_id);
  let candidates: string[];
  try {
    const away = await deps.userIdsOnApprovedTimeOff(askable, startIso, endIso);
    candidates = ordered.filter((id) => !away.has(id));
  } catch {
    // FAIL CLOSED, and specifically as an OUTAGE rather than as no-coverage. An
    // `unplaceable` outcome is terminal in the bulk engine, so treating an
    // unreadable time-off check as "nobody available" would let one database
    // hiccup strand a customer's booking on an absent agent permanently. Reporting
    // it unverified reuses the retry path a Google verify outage already takes, and
    // never places the booking on an agent we could not check.
    return { assignment: null, anyUnverified: true };
  }

  // Cap is checked ONLY for a confirmed-free candidate (in `selectReassignTarget`),
  // so an uncapped event type or a busy agent never triggers these reads.
  const isUnderCap = async (userId: string): Promise<boolean> => {
    if (eventType.daily_cap === null) return true;
    const wh = await deps.agentWorkingHours(userId);
    const day = DateTime.fromISO(booking.starts_at, { zone: wh.timezone }).startOf("day");
    const startsMs = await deps.agentActiveBookingStartsMs(
      userId,
      day.toISO()!,
      day.plus({ days: 1 }).toISO()!,
      booking.id,
    );
    return isUnderDailyCap(startsMs, wh.timezone, Date.parse(booking.starts_at), eventType.daily_cap);
  };

  return selectReassignTarget(
    candidates,
    booking.assigned_user_id,
    (ids) => deps.loadEmails(ids),
    (emails, ids) => {
      const [fromIso, toIso] = bufferedWindow(eventType, startIso, endIso);
      return deps.verifyFree(emails, fromIso, toIso, ids);
    },
    isUnderCap,
    COVERAGE_VERIFY_WAVE_SIZE,
  );
}

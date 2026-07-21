import { DateTime } from "luxon";

import { isUnderDailyCap, type WorkingRule } from "@/lib/availability/compute";
import { bookingWindow, selectReassignTarget, type SelectionOutcome, type VerifyResult } from "@/lib/booking/core";
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
  verifyFree(emails: string[], startIso: string, endIso: string): Promise<VerifyResult>;
  /** One agent's working-hours schedule (timezone + rules), for the cap's local day. */
  agentWorkingHours(userId: string): Promise<{ timezone: string; rules: WorkingRule[] }>;
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
 */
export async function selectCoverageReassignTarget(
  ctx: { booking: Booking; bucket: Bucket; eventType: EventType },
  deps: CoverageTargetDeps,
): Promise<SelectionOutcome> {
  const { booking, bucket, eventType } = ctx;
  const { startIso, endIso } = bookingWindow(booking.starts_at, eventType.duration_min);
  const candidates = await deps.orderedEligibleIds(bucket);

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
    (emails) => deps.verifyFree(emails, startIso, endIso),
    isUnderCap,
    COVERAGE_VERIFY_WAVE_SIZE,
  );
}

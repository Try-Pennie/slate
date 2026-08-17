/**
 * The calendar hydration rotation (#1261): which calendars get re-bootstrapped this tick,
 * and over what window.
 *
 * WHY RE-BOOTSTRAP AT ALL, when the sync token already streams changes. Google's delta is
 * NOT scoped to the window the bootstrap asked for (measured, #1252), and an unchanged
 * event is delivered exactly ONCE. So the moment anything filters or prunes the cache by
 * window, a far future event created and never touched again is dropped and never re-added
 * when the horizon slides up to it. Hydration is what makes that filter safe, which is why
 * it ships first and runs alone for a full cycle before #1264 lands.
 *
 * Pure, and free of Cloudflare and Supabase imports, so every branch is driven offline by
 * scripts/test-calendar-hydration.ts.
 */
import {
  BOOTSTRAP_LOOKBACK_MS,
  BUSY_WINDOW_AHEAD_DAYS,
  eligibleCalendarsForSync,
} from "@/lib/google/sync-coalesce";
import { parseStampMs } from "@/lib/date/stamp";

/** Ticks a day at the lane's every-fifteen-minutes trigger. Written in words rather than
 *  as the cron expression because a slash-star inside a block comment closes it. Its own
 *  expression, never the every-minute invocation, which is the one already short of CPU
 *  headroom (#1245). */
export const HYDRATION_TICKS_PER_DAY = 96;

/** Never fetch fewer than this, so a small or briefly-unreadable roster still makes
 *  progress instead of rounding down to nothing. */
export const HYDRATION_MIN_BATCH = 2;

/**
 * How many calendars to refresh this tick, DERIVED from the live count.
 *
 * A hardcoded number is the failure this exists to avoid. Five an hour is 120 a day, which
 * clears 119 calendars with no slack at all, and at the design target of 100 to 200 agents
 * it silently becomes a refresh every OTHER day while the safety margin erodes and nothing
 * reports it. Deriving it means the cadence holds at any roster size, and the property is
 * asserted as arithmetic in the test rather than trusted.
 */
export function hydrationBatchSize(calendarCount: number): number {
  const needed = Math.ceil(Math.max(0, calendarCount) / HYDRATION_TICKS_PER_DAY);
  return Math.max(HYDRATION_MIN_BATCH, needed);
}

/**
 * The bounds this pass will send to Google.
 *
 * Returned together, and passed onward together, because the reconcile that follows may
 * only judge what the fetch actually asked for. Re-reading a stored window instead is the
 * one shape that can over-delete: a stored value larger than what was sent would extend
 * the reconcile past the fetch and remove cached busy time nothing had read.
 */
export function hydrationWindow(nowMs: number): { timeMinIso: string; timeMaxIso: string } {
  return {
    timeMinIso: new Date(nowMs - BOOTSTRAP_LOOKBACK_MS).toISOString(),
    timeMaxIso: new Date(nowMs + BUSY_WINDOW_AHEAD_DAYS * 24 * 60 * 60_000).toISOString(),
  };
}

/** The columns this rotation needs off a calendar row. */
export interface HydrationCandidate {
  id: string;
  sync_token: string | null;
  last_failure_kind: "gone" | "not-provisioned" | "transient" | null;
  consecutive_failures: number;
  last_bootstrap_attempt_at: string | null;
}

/**
 * This tick's batch: the least recently ATTEMPTED calendars first, capped at `batchSize`.
 *
 * Two things make the ordering safe.
 *
 * It keys on the ATTEMPT stamp, not on success. Ordering by coverage would let a calendar
 * whose delegation has been revoked stay the oldest forever, so it would be selected first
 * on every single tick and starve every healthy calendar behind it.
 *
 * And it applies the SHARED eligibility predicate, so an established-gone calendar is held
 * back to its periodic retry slot rather than consuming a place in every batch. Shared
 * rather than re-implemented: a second copy of "is this calendar worth attempting" would
 * drift from the one the every-minute lane uses, and #1396 is what happens when a caller
 * hand-rolls that test instead.
 *
 * An unreadable or missing stamp sorts as never attempted, the fail-safe side. `Date.parse`
 * returns NaN for a value it cannot read and NaN compares false against everything, so a
 * raw comparison would silently park such a calendar at the back of the queue forever (L50).
 */
export function calendarsDueForHydration<T extends HydrationCandidate>(
  calendars: T[],
  nowMs: number,
  batchSize: number,
): T[] {
  if (batchSize <= 0) return [];
  const eligible = eligibleCalendarsForSync(calendars, nowMs);
  // Number.NEGATIVE_INFINITY for "never attempted", so it sorts ahead of every real stamp
  // without any special case in the comparator.
  const attemptedAt = (c: T): number =>
    parseStampMs(c.last_bootstrap_attempt_at) ?? Number.NEGATIVE_INFINITY;
  return [...eligible].sort((a, b) => attemptedAt(a) - attemptedAt(b)).slice(0, batchSize);
}

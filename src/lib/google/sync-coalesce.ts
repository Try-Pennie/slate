/**
 * Pure helpers for the DB-backed sync coordination (#30). Cloudflare Workers
 * isolates share no memory, so claims/locks live in Postgres; these compute
 * the claim timestamps and the rerun decision. Exercised by
 * scripts/test-sync-coalesce.ts.
 */

/** A calendar claim older than this is considered abandoned and stealable. */
export const CALENDAR_CLAIM_TTL_MS = 60_000;
/** Cron lock TTL: an incremental pass finishes well inside this. */
export const CRON_LOCK_TTL_MS = 5 * 60_000;
/**
 * Recompute lane lock TTL (#273): shorter than the sync lock so a wedged
 * recompute claim self-heals within ~2 min instead of blacking out slot
 * freshness for the full 5-min window. Must exceed RECOMPUTE_BUDGET_MS.
 */
export const RECOMPUTE_LOCK_TTL_MS = 2 * 60_000;
/**
 * Watch lane lock TTL (#273): under the 5-minute cadence so a wedged watch
 * claim self-heals on the NEXT tick instead of skipping an extra cycle. The pass
 * (mostly cheap DB expiry checks) finishes well inside this.
 */
export const WATCH_LOCK_TTL_MS = 4 * 60_000;
/** Burst bound: how many back-to-back passes one holder will run. */
export const MAX_SYNC_PASSES = 3;

export interface ClaimWindow {
  /** The timestamp this request writes as its claim. */
  claimIso: string;
  /** Claims strictly older than this are stale and may be stolen. */
  staleBeforeIso: string;
}

export function claimWindow(nowMs: number, ttlMs: number): ClaimWindow {
  return {
    claimIso: new Date(nowMs).toISOString(),
    staleBeforeIso: new Date(nowMs - ttlMs).toISOString(),
  };
}

/**
 * After a sync pass: run again only if new pushes flagged the calendar while
 * we were syncing, and the burst bound hasn't been hit (the 1-minute cron
 * backstop picks up anything beyond it).
 */
export function shouldRerun(
  pendingAgain: boolean,
  passesDone: number,
  maxPasses: number = MAX_SYNC_PASSES,
): boolean {
  return pendingAgain && passesDone < maxPasses;
}

/**
 * Per-tick work budget (#44): a cron invocation stops STARTING new calendar
 * syncs once the budget elapses (per-calendar granularity - one oversized
 * bootstrap can still finish its calendar). Sync tokens make the next tick
 * resume for free, so a fleet-wide resync drains across ticks instead of
 * blowing Cloudflare Worker execution limits.
 */
export const SYNC_TICK_BUDGET_MS = 25_000;

export function pastDeadline(nowMs: number, deadlineMs: number | null): boolean {
  return deadlineMs !== null && nowMs >= deadlineMs;
}

/**
 * Cheap incrementals (token present) first, expensive bootstraps (no token)
 * last: a long bootstrap then consumes the tail of the budget instead of
 * starving every working calendar's freshness. Stable within each group.
 */
export function orderCalendarsForSync<T extends { sync_token: string | null }>(
  cals: T[],
): T[] {
  return [...cals].sort(
    (a, b) => Number(a.sync_token === null) - Number(b.sync_token === null),
  );
}

/**
 * Consecutive `gone` classifications before a calendar is treated as ESTABLISHED
 * gone rather than possibly-misread. One or two can be a bad response from
 * Google; three in a row on the minute lane is a real revocation.
 */
export const GONE_BACKOFF_STREAK = 3;

/**
 * How often an established-gone calendar is still attempted, in minutes.
 *
 * Ten, not the sixty the issue floated, because this interval is also the
 * RECOVERY LAG: nothing marks a calendar un-gone except an attempt that
 * succeeds, so whatever is chosen here is how long a human's fix can sit
 * unnoticed by the rotation lane. Ten still removes ~90% of the wasted calls
 * (1440 attempts a day becomes 144) while keeping that lag inside a coffee
 * break. Re-activating an agent goes through the live bookable check instead,
 * which is immediate and does not wait on this at all.
 */
export const GONE_RETRY_INTERVAL_MIN = 10;

/** Stable non-cryptographic hash of a calendar id (FNV-1a, 32-bit). Used only to
 *  spread retries across minutes, so collisions are harmless. */
function slotHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Is this calendar due for a sync attempt on the rotation lane right now?
 *
 * True for everything except a calendar that is ESTABLISHED gone, which gets one
 * attempt per `GONE_RETRY_INTERVAL_MIN` on a minute derived from its own id.
 *
 * Why a clock slot rather than a counter or a timestamp (#1049): there is no
 * `last_attempt_at` column, and `last_success_at` stops moving the moment a
 * calendar starts failing, so neither can answer "when did we last try". A
 * counter cannot work either, because SKIPPING an attempt records no failure, so
 * `consecutive_failures` freezes at whatever value triggered the skip and the
 * rule then fires either never or every tick. Hashing the id against the wall
 * clock needs no new column and no stored state, is stable for a given calendar,
 * and spreads a fleet of dead calendars across different minutes instead of
 * having them all retry in the same tick.
 *
 * Deliberately scoped to the every-minute rotation lane (`runIncrementalSync`),
 * its only caller. A push webhook or a human re-activating an agent does not
 * come through here, so neither is ever delayed by this.
 */
export function syncEligible(
  cal: { id: string; last_failure_kind: "gone" | "transient" | null; consecutive_failures: number },
  nowMs: number,
  intervalMin: number = GONE_RETRY_INTERVAL_MIN,
): boolean {
  const established =
    cal.last_failure_kind === "gone" && cal.consecutive_failures >= GONE_BACKOFF_STREAK;
  if (!established) return true;
  const minuteOfEpoch = Math.floor(nowMs / 60_000);
  return minuteOfEpoch % intervalMin === slotHash(cal.id) % intervalMin;
}

/** The rotation lane's calendar list: sync order, minus anything backed off. */
export function eligibleCalendarsForSync<
  T extends {
    id: string;
    sync_token: string | null;
    last_failure_kind: "gone" | "transient" | null;
    consecutive_failures: number;
  },
>(cals: T[], nowMs: number): T[] {
  return orderCalendarsForSync(cals).filter((c) => syncEligible(c, nowMs));
}

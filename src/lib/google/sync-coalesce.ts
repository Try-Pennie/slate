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

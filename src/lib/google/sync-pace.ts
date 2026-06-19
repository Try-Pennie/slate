/**
 * Pure helpers for pacing the every-minute backstop sync cron across a large
 * agent roster (#238). The cron is a backstop + watch renewer (real-time
 * freshness comes from Google push), so it bounds its own work per tick and
 * rotates least-recently-synced agents first instead of re-processing the same
 * head of the list every minute. Exercised by scripts/test-sync-pace.ts and
 * scripts/test-sync-agents.ts.
 */

/** Cap on brand-new agents onboarded (first watch setup) per cron tick. */
export const MAX_ONBOARDS_PER_TICK = 10;

export interface SyncAgent {
  userId: string;
  /** Whether the agent already has agent_calendars rows (DB-only check). */
  hasCalendars: boolean;
  /** users.last_synced_at as epoch ms, or null if never synced by the cron. */
  lastSyncedMs: number | null;
}

/** A users row as loaded for sync candidacy (bookable pool). */
export interface SyncCandidateRow {
  id: string;
  last_synced_at: string | null;
  deactivated_at: string | null;
}

/**
 * Shape the bookable-user rows into per-tick pacing facts, dropping any
 * deactivated user (#274) so the sync/watch loop never touches an offboarded
 * account. The query already filters `deactivated_at IS NULL`; re-checking
 * here is belt-and-braces and the node-testable seam. The `deactivated_at ==
 * null` predicate mirrors isActive() but is kept inline so this stays a
 * dependency-free pure module (cf. offboarding/plan.ts).
 */
export function toSyncAgents(
  rows: SyncCandidateRow[],
  calendarUserIds: Set<string>,
): SyncAgent[] {
  return rows
    .filter((r) => r.deactivated_at == null)
    .map((r) => ({
      userId: r.id,
      hasCalendars: calendarUserIds.has(r.id),
      lastSyncedMs: r.last_synced_at ? Date.parse(r.last_synced_at) : null,
    }));
}

/**
 * True while the tick still has budget. A null deadline means "unbounded"
 * (used by callers that pass no budget) and always returns true. The positive
 * form the cron loop guards on; inverse of sync-coalesce.ts pastDeadline.
 */
export function withinBudget(nowMs: number, deadlineMs: number | null): boolean {
  return deadlineMs === null || nowMs < deadlineMs;
}

/**
 * Least-recently-synced first: never-synced agents (lastSyncedMs null) lead,
 * then ascending lastSyncedMs. Stable within each group so the DB's order is
 * preserved among ties. Returns a new array; never mutates the input.
 */
export function orderAgentsForTick(agents: SyncAgent[]): SyncAgent[] {
  return [...agents].sort((a, b) => {
    const an = a.lastSyncedMs === null;
    const bn = b.lastSyncedMs === null;
    if (an !== bn) return an ? -1 : 1; // nulls first
    if (an && bn) return 0; // both never-synced: stable
    return (a.lastSyncedMs as number) - (b.lastSyncedMs as number);
  });
}

/**
 * Whether to spend this tick's onboarding budget on this agent. Only agents
 * with no calendars yet need first-time watch setup (the ~2-Google-call path);
 * already-onboarded agents are synced without counting against the cap.
 */
export function shouldOnboard(
  agent: SyncAgent,
  onboardedSoFar: number,
  cap: number = MAX_ONBOARDS_PER_TICK,
): boolean {
  return !agent.hasCalendars && onboardedSoFar < cap;
}

/**
 * Pure per-calendar sync-health transition (#273 Phase 1). Each agent_calendars
 * row tracks last_success_at, a consecutive_failures streak, and last_sync_error
 * so the operator can tell a transient blip from a persistent problem and an
 * alert can NAME the failing agent + how long it's been down. Kept pure (no
 * imports) so the transition is node-testable; sync.ts persists the result.
 * Exercised by scripts/test-sync-health.ts.
 */

export interface CalSyncHealth {
  consecutive_failures: number;
  last_success_at: string | null;
  last_sync_error: string | null;
}

export type SyncOutcome = { ok: true } | { ok: false; error: string };

/**
 * Next health state after an attempt. Success clears the streak + error and
 * stamps last_success_at; failure increments the streak and records the error
 * but PRESERVES last_success_at (so "down since X" stays meaningful).
 */
export function nextSyncState(
  prev: CalSyncHealth,
  outcome: SyncOutcome,
  nowIso: string,
): CalSyncHealth {
  if (outcome.ok) {
    return {
      consecutive_failures: 0,
      last_success_at: nowIso,
      last_sync_error: null,
    };
  }
  return {
    consecutive_failures: prev.consecutive_failures + 1,
    last_success_at: prev.last_success_at,
    last_sync_error: outcome.error,
  };
}

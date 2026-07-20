/**
 * Pure per-calendar sync-health transition (#273 Phase 1). Each agent_calendars
 * row tracks last_success_at, a consecutive_failures streak, and last_sync_error
 * so the operator can tell a transient blip from a persistent problem and an
 * alert can NAME the failing agent + how long it's been down. Kept pure (no
 * imports) so the transition is node-testable; sync.ts persists the result.
 * Exercised by scripts/test-sync-health.ts.
 */

/**
 * How a failure was classified (#916): a definitively-GONE account (a 4xx from
 * the token mint or calendar API: delegation revoked, account removed from the
 * Workspace) needs a human, while a TRANSIENT failure (5xx, timeout, rate limit)
 * usually self-heals. Structurally identical to the reachability classifier's
 * non-reachable outcomes; kept as a local literal so this module stays
 * import-free and node-testable.
 */
export type FailureKind = "gone" | "transient";

export interface CalSyncHealth {
  consecutive_failures: number;
  last_success_at: string | null;
  last_sync_error: string | null;
  /** #916: classification of the last failure, or null when the last attempt
   *  succeeded (or predates the classification shipping). */
  last_failure_kind: FailureKind | null;
}

export type SyncOutcome =
  | { ok: true }
  | { ok: false; error: string; kind?: FailureKind };

/**
 * Next health state after an attempt. Success clears the streak + error + kind
 * and stamps last_success_at; failure increments the streak, records the error
 * and its classification, but PRESERVES last_success_at (so "down since X" stays
 * meaningful). An unclassified failure (`kind` omitted) records a null kind,
 * which the paging policy treats conservatively as gone (never goes silent).
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
      last_failure_kind: null,
    };
  }
  return {
    consecutive_failures: prev.consecutive_failures + 1,
    last_success_at: prev.last_success_at,
    last_sync_error: outcome.error,
    last_failure_kind: outcome.kind ?? null,
  };
}

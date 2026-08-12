/**
 * Pure per-calendar sync-health transition (#273 Phase 1). Each agent_calendars
 * row tracks last_success_at, a consecutive_failures streak, and last_sync_error
 * so the operator can tell a transient blip from a persistent problem and an
 * alert can NAME the failing agent + how long it's been down. Kept pure (no
 * imports) so the transition is node-testable; sync.ts persists the result.
 * Exercised by scripts/test-sync-health.ts.
 */

/**
 * How a failure was classified (#916, extended in #1396): a definitively-GONE
 * account (a 4xx from the token mint or calendar API: delegation revoked, account
 * removed from the Workspace) needs a human, a NOT-PROVISIONED account
 * (`403 notACalendarUser`) needs a DIFFERENT human doing a different thing (a
 * Workspace admin giving them Calendar), and a TRANSIENT failure (5xx, timeout,
 * rate limit) usually self-heals. Use `isDefinitiveFailure` rather than comparing
 * against "gone", or the second kind reads as retryable. Structurally identical to the reachability classifier's
 * non-reachable outcomes; kept as a local literal so this module stays
 * import-free and node-testable.
 */
export type FailureKind = "gone" | "not-provisioned" | "transient";

/**
 * Is this failure one that no amount of retrying will fix? (#1396)
 *
 * The ONE predicate every gate branches on, so adding a third definitive kind
 * cannot silently fail OPEN. A gate written as `kind === "gone"` treats
 * `not-provisioned` as transient, which means retrying an account forever and, at
 * the activation gate, the difference between refusing an agent and admitting one
 * whose availability can never be read.
 *
 * A null or missing kind counts as definitive, matching #916's conservative
 * default: a failure recorded before the classification shipped must not go
 * quiet.
 */
export function isDefinitiveFailure(kind: FailureKind | "reachable" | null | undefined): boolean {
  return kind !== "transient" && kind !== "reachable";
}

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

/**
 * Which lane's health a read or write is about (#1150). The transition above is
 * shared, but the two lanes must land in DIFFERENT columns.
 */
export type HealthLane = "sync" | "watch";

/**
 * The `agent_calendars` columns each lane's health lives in (#1150).
 *
 * Both lanes used to write the sync set, and they run at different cadences: the
 * sync lane every minute (resetting the streak on each success) and the watch
 * lane every ~5 minutes (incrementing it on a failed renewal). A renewal failure
 * was therefore erased before it could reach a paging threshold, which made
 * "Google push is degraded but events still sync" impossible to alert on, and a
 * successful renewal could equally erase a real sync-failure streak.
 *
 * Kept as data rather than two hand-written mappers so a caller cannot name one
 * lane and write the other's column, and so a test can assert directly that the
 * two sets do not overlap.
 */
export const LANE_COLUMNS = {
  sync: {
    failures: "consecutive_failures",
    lastSuccess: "last_success_at",
    error: "last_sync_error",
    kind: "last_failure_kind",
  },
  watch: {
    failures: "watch_consecutive_failures",
    lastSuccess: "watch_last_success_at",
    error: "watch_last_error",
    kind: "watch_last_failure_kind",
  },
} as const satisfies Record<HealthLane, Record<string, string>>;

/**
 * A health state as the column payload for ONE lane (#1150), the shape handed
 * to the `agent_calendars` update. Only that lane's four columns appear, so a
 * write can never touch the other lane's streak.
 */
export function laneHealthUpdate(
  lane: HealthLane,
  next: CalSyncHealth,
): Record<string, string | number | null> {
  const col = LANE_COLUMNS[lane];
  return {
    [col.failures]: next.consecutive_failures,
    [col.lastSuccess]: next.last_success_at,
    [col.error]: next.last_sync_error,
    [col.kind]: next.last_failure_kind,
  };
}

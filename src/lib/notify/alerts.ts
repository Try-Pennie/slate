/**
 * Pure alert helpers (no IO) — throttle decision + message formatting, kept
 * import-free so they're unit-testable. The Slack transport lives in
 * `./slack.ts`; the cooldown state is persisted by the caller.
 */

/** Send only if we've never alerted, or the cooldown has elapsed. */
export function shouldSendAlert(
  lastSentAtMs: number | null,
  nowMs: number,
  cooldownMs: number,
): boolean {
  if (lastSentAtMs == null) return true;
  return nowMs - lastSentAtMs >= cooldownMs;
}

/** A persistently-failing agent calendar, for the named alert (#273). */
export interface FailingAgent {
  email: string;
  consecutiveFailures: number;
  /** ISO timestamp of the last clean sync/renew, or null if never. */
  lastSuccessAt: string | null;
  /** Last error message, or null. */
  error: string | null;
  /** #916: classification of the worst calendar's last failure, or null when
   *  unclassified (a failure recorded before the classification shipped). */
  failureKind?: "gone" | "transient" | null;
}

/** A joined agent_calendars + users row, as loaded for the failing-agent alert. */
export interface FailingCalendarRow {
  consecutive_failures: number;
  last_success_at: string | null;
  last_sync_error: string | null;
  email: string | null;
  bookable: boolean;
  deactivated_at: string | null;
  /** #916: last failure's classification ('gone' | 'transient'), or null. */
  last_failure_kind?: string | null;
}

/**
 * Consecutive-failure thresholds at which a failing calendar PAGES, by
 * classification (#916). A definitively-GONE account (a 4xx: delegation revoked
 * / account removed) needs a human, so it pages at the same streak as before; a
 * TRANSIENT failure (5xx / timeout / rate limit) usually self-heals, so it must
 * persist LONGER before paging, cutting alert noise. A null kind (a failure
 * recorded before #916, or an odd shape) is treated as gone so no streak that
 * used to page ever goes silent.
 */
export const GONE_PAGE_AT = 2;
export const TRANSIENT_PAGE_AT = 4;

/** Whether a failing calendar has crossed its per-kind paging threshold (#916).
 *  Applied per row BEFORE dedup so a genuinely-gone calendar at its threshold is
 *  never hidden behind a same-agent transient calendar with a longer streak. */
export function isPageableFailure(
  kind: string | null | undefined,
  consecutiveFailures: number,
): boolean {
  const threshold = kind === "transient" ? TRANSIENT_PAGE_AT : GONE_PAGE_AT;
  return consecutiveFailures >= threshold;
}

/**
 * Collapse the raw failing-calendar rows to one entry per agent (#273): an
 * agent can have several calendars, so keep the WORST (highest streak) and its
 * error. Drop deactivated/non-bookable agents and rows with no email (no one
 * to alert about). Sorted by streak descending so the worst are named first.
 */
export function dedupeFailingAgents(rows: FailingCalendarRow[]): FailingAgent[] {
  const byEmail = new Map<string, FailingAgent>();
  for (const r of rows) {
    if (!r.email || !r.bookable || r.deactivated_at) continue;
    const cur = byEmail.get(r.email);
    if (!cur || r.consecutive_failures > cur.consecutiveFailures) {
      byEmail.set(r.email, {
        email: r.email,
        consecutiveFailures: r.consecutive_failures,
        lastSuccessAt: r.last_success_at,
        error: r.last_sync_error,
        failureKind:
          r.last_failure_kind === "gone" || r.last_failure_kind === "transient"
            ? r.last_failure_kind
            : null,
      });
    }
  }
  return [...byEmail.values()].sort(
    (a, b) => b.consecutiveFailures - a.consecutiveFailures,
  );
}

/** How many agents to name inline before summarizing the rest. */
const MAX_NAMED_AGENTS = 5;

/** The bulleted, capped per-agent lines shared by the named alerts (#293). */
function failingAgentLines(failing: FailingAgent[]): string {
  const lines = failing.slice(0, MAX_NAMED_AGENTS).map((a) => {
    const lastOk = a.lastSuccessAt ? a.lastSuccessAt.slice(0, 10) : "never";
    const err = a.error ? ` (${a.error.slice(0, 120)})` : "";
    const n = a.consecutiveFailures;
    // #916: name the classification so ops knows which need a human now vs which
    // are likely self-healing.
    const kind =
      a.failureKind === "gone"
        ? " [account gone: re-auth or deactivate]"
        : a.failureKind === "transient"
          ? " [transient: likely self-healing]"
          : "";
    return `• ${a.email}: ${n} consecutive failure${n === 1 ? "" : "s"}, last ok ${lastOk}${kind}${err}`;
  });
  const extra = failing.length - MAX_NAMED_AGENTS;
  return lines.join("\n") + (extra > 0 ? `\n…and ${extra} more` : "");
}

/**
 * Human-readable watch-lapse alert that NAMES the failing agent(s) (#273
 * Phase 1.3) — replacing the old "N of M" body that named nobody and forced a
 * hand DB query. Lists each agent's email, consecutive-failure count, last
 * successful sync, and error, plus the remediation, capped with a summary tail.
 */
export function formatWatchLapseAlert(
  failing: FailingAgent[],
  totalAgents: number,
): string {
  return (
    `Slate: ${failing.length} of ${totalAgents} bookable agent` +
    `${failing.length === 1 ? "" : "s"} have a calendar failing to sync/renew ` +
    `(Google push degraded; availability is on the backup cron). ` +
    `Re-auth or deactivate:\n${failingAgentLines(failing)}`
  );
}

/**
 * Named sync-failure alert (#293): the backstop sync errored on consecutive
 * passes — name the failing agent(s) (same shape as the watch alert) instead
 * of an anonymous count, so the cache-drift can be acted on without a DB query.
 */
export function formatSyncFailureAlert(
  failing: FailingAgent[],
  totalAgents: number,
): string {
  return (
    `Slate: calendar sync is failing for ${failing.length} of ${totalAgents} ` +
    `bookable agent${failing.length === 1 ? "" : "s"} on consecutive passes ` +
    `(the availability cache may be drifting from Google). Re-auth or deactivate:` +
    `\n${failingAgentLines(failing)}`
  );
}

/**
 * Alert only on a CONSECUTIVE failure (#43): the caller bumps a counter per
 * failing pass (cleared on success); the first failure stays quiet so a
 * transient Google blip never pages anyone.
 */
export function isConsecutiveFailure(failuresInWindow: number): boolean {
  return failuresInWindow >= 2;
}

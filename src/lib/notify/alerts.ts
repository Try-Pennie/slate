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
}

/** A joined agent_calendars + users row, as loaded for the failing-agent alert. */
export interface FailingCalendarRow {
  consecutive_failures: number;
  last_success_at: string | null;
  last_sync_error: string | null;
  email: string | null;
  bookable: boolean;
  deactivated_at: string | null;
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
    return `• ${a.email}: ${n} consecutive failure${n === 1 ? "" : "s"}, last ok ${lastOk}${err}`;
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

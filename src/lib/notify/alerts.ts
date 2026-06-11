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

/** Human-readable watch-lapse alert body. */
export function formatWatchLapseAlert(
  watchErrors: number,
  totalAgents: number,
): string {
  return (
    `Slate: ${watchErrors} of ${totalAgents} bookable agent calendar ` +
    `watch${watchErrors === 1 ? "" : "es"} failed to renew. Google push may be ` +
    `degraded, so availability is falling back to the backup cron sync. ` +
    `Check the admin page for push status.`
  );
}

/** First error string from a cron sync pass, for the alert body. */
export function formatSyncFailureAlert(
  syncErrors: number,
  totalAgents: number,
  firstError: string | null,
): string {
  return (
    `Slate: calendar sync failed for ${syncErrors} of ${totalAgents} bookable ` +
    `agent${syncErrors === 1 ? "" : "s"} on consecutive cron passes. The ` +
    `availability cache may be drifting from Google.` +
    (firstError ? ` First error: ${firstError.slice(0, 300)}` : "")
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

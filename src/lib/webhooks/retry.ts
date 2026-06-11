/**
 * Pure retry policy for webhook deliveries. The cron sweep uses these to decide
 * which failed (or stuck-pending) deliveries are due, with exponential backoff
 * so a flapping subscriber isn't hammered every minute.
 */

export const WEBHOOK_MAX_ATTEMPTS = 5;

/** Backoff before the next attempt, given attempts already made. Capped at 30m. */
export function webhookBackoffMs(attempts: number): number {
  const minutes = Math.min(Math.pow(2, Math.max(attempts, 0)), 30);
  return minutes * 60_000;
}

/** Due for (re)delivery if attempts remain and the backoff window has elapsed. */
export function isDueForRetry(
  attempts: number,
  lastAttemptMs: number,
  nowMs: number,
): boolean {
  if (attempts >= WEBHOOK_MAX_ATTEMPTS) return false;
  return nowMs - lastAttemptMs >= webhookBackoffMs(attempts);
}

/**
 * Dead-lettered: the cron sweep has given up (failed with attempts
 * exhausted). These are what batch replay (#33) targets - anything under the
 * cap is still owned by the automatic retry loop.
 */
export function isDeadLettered(
  status: string,
  attempts: number,
  maxAttempts: number = WEBHOOK_MAX_ATTEMPTS,
): boolean {
  return status === "failed" && attempts >= maxAttempts;
}

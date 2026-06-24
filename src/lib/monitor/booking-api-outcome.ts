/**
 * Pure format for the direct booking API outcome log line (#375). The booking
 * API already computes a per-call outcome; this emits it as a stable, parseable
 * structured line so Cloudflare Workers observability can tally the mix
 * (confirm_required rate, cross-bucket moves, no-eligible-agents, errors) once
 * the bot is live. Alerting on the tally is deferred until there's a baseline;
 * this just lays down the queryable signal. No `@/` imports so
 * scripts/test-monitor-booking-api-outcome.ts can run it node-native.
 */

/** Stable prefix an observability query matches on; the rest of the line is JSON. */
export const OUTCOME_LOG_PREFIX = "booking-api-outcome";

export interface BookingApiOutcome {
  /** created | deduped | rescheduled | confirm_required | error */
  outcome: string;
  bucketCode: string;
  /** Which API key served the call (primary | secondary). */
  keyId: string;
  /** HTTP status returned. */
  status: number;
  /** Machine error code when outcome is "error" (e.g. SLOT_TAKEN). */
  code?: string;
}

/** A single structured log line: the stable prefix followed by a JSON payload. */
export function formatOutcomeLine(o: BookingApiOutcome): string {
  return `${OUTCOME_LOG_PREFIX} ${JSON.stringify(o)}`;
}

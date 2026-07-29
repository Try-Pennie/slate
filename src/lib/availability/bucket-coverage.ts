/**
 * No-eligible-agents monitor (#327) — pure decision + alert copy. A bucket whose
 * eligible pool resolves to ZERO agents (matched pool empty AND no usable
 * fallback) is a routing dead zone: a lead routed there can't be booked. The
 * proactive sweep (hourly, after the roster reconcile) and the reactive
 * booking-time signal both build their throttled-alert text here. Pure so it
 * unit-tests node-native; the IO (loading buckets, resolving pools, sending the
 * alert) lives in the availability service / cron.
 */

export interface BucketCoverage {
  code: string;
  /** Eligible bookable agents the bucket currently resolves to (incl. fallback). */
  eligibleCount: number;
}

/** Bucket codes that route to NO eligible agent — a dead zone. */
export function emptyBuckets(coverage: BucketCoverage[]): string[] {
  return coverage.filter((b) => b.eligibleCount === 0).map((b) => b.code);
}

/**
 * Per-bucket proactive-alert text. The sweep sends ONE throttled alert per dead
 * bucket (keyed by code) rather than a single combined alert, so two buckets
 * going empty close together each surface under their own throttle instead of
 * the second being suppressed by a shared key.
 */
export function emptyBucketMessage(code: string): string {
  return (
    `Slate: booking bucket ${code} has NO eligible bookable agents and cannot ` +
    `route a lead. Check its agent attributes, bookable flags, and schedules ` +
    `before customers hit it.`
  );
}

/**
 * The all-clear for a bucket that routes somewhere again (#1151).
 *
 * The page told someone a bucket could not take a lead, so the thing they need
 * next is that it can. It names the count, because "has agents again" and "has
 * exactly one agent again" call for different follow-up.
 */
export function recoveredBucketMessage(code: string, eligibleCount: number): string {
  const who = eligibleCount === 1 ? "1 eligible bookable agent" : `${eligibleCount} eligible bookable agents`;
  return (
    `Slate: booking bucket ${code} can route leads again (${who}). The earlier page about it ` +
    `having nobody to route to is cleared. No action is needed.`
  );
}

/**
 * Reactive alert text: a live booking just hit a bucket with no eligible agents.
 * Tolerates a missing bucket code (defensive).
 */
export function noEligibleAgentsAlert(bucketCode: string | null): string {
  const where = bucketCode ? `bucket ${bucketCode}` : "a booking bucket";
  return (
    `Slate: a booking just failed because ${where} has NO eligible bookable agents ` +
    `to route to. A lead could not be booked. Check the bucket's agent attributes, ` +
    `bookable flags, and schedules.`
  );
}

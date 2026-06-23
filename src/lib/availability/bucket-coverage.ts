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
 * Throttled-alert text for the proactive sweep, or null when every bucket has at
 * least one eligible agent (nothing to alert).
 */
export function emptyBucketAlert(coverage: BucketCoverage[]): string | null {
  const empty = emptyBuckets(coverage);
  if (empty.length === 0) return null;
  return (
    `Slate: ${empty.length} booking bucket(s) have NO eligible bookable agents and ` +
    `cannot route a lead: ${empty.join(", ")}. Check agent attributes, bookable ` +
    `flags, and schedules for these buckets before customers hit them.`
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

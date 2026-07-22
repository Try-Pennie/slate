/**
 * Availability canary verdict (#749). Pure and IO-free so it is node-unit-testable
 * (see scripts/test-availability-canary.ts); the route feeds it the per-bucket
 * present-agent depth (from loadTierDepths) and the 4-day slot cache counts (from
 * bucket_slots), and it decides 200 (healthy) vs 503 (degraded).
 *
 * The signal it catches is a booker that responds fine but silently offers no
 * times, which /api/health cannot see (the DB is up and the crons tick). It is
 * PTO-aware: a bucket is only "broken" when agents are actually present but it has
 * zero times, so a tier that is empty because everyone who staffs it is off never
 * pages. It errs quiet on ambiguity: a lone tiny empty bucket (which could just be
 * booked solid) is not a break, only a strongly-staffed empty tier or a systemic
 * wave of empties is.
 */

export interface BucketPresence {
  code: string;
  /** Present agents: bookable, matched to the bucket, minus those out today. */
  effectiveDepth: number;
}

export interface BrokenBucket {
  code: string;
  effectiveDepth: number;
  slots: number;
}

export interface CanaryVerdict {
  healthy: boolean;
  httpStatus: 200 | 503;
  /** Machine reason: ok | tier_broken | systemic_empty | cache_absent. */
  reason: string;
  /** Staffed buckets (present agents > 0) with a known slot count. */
  staffedCount: number;
  /** Staffed buckets showing zero cached slots, worst (most present agents) first. */
  brokenBuckets: BrokenBucket[];
  /** Buckets present in the roster but missing from the slot cache (not judged). */
  unknownCount: number;
}

export interface CanaryThresholds {
  /** A single broken bucket with at least this many present agents pages on its own:
   *  that many present agents with no times between them is not a coincidence. */
  strongAgentFloor: number;
  /** Or, page when at least this fraction of staffed buckets are empty at once
   *  (a systemic collapse), even if each empty bucket is individually small. */
  systemicFraction: number;
  /** ...but only once at least this many buckets are actually broken, so a single
   *  empty bucket among a handful of staffed ones can't read as "half are down". */
  systemicMinBroken: number;
}

export const DEFAULT_CANARY_THRESHOLDS: CanaryThresholds = {
  strongAgentFloor: 3,
  systemicFraction: 0.5,
  systemicMinBroken: 3,
};

export function computeAvailabilityCanary(
  depths: BucketPresence[],
  slotCountByCode: Map<string, number>,
  thresholds: CanaryThresholds = DEFAULT_CANARY_THRESHOLDS,
): CanaryVerdict {
  const staffed = depths.filter((d) => d.effectiveDepth > 0);

  const unknownCount = staffed.filter((d) => !slotCountByCode.has(d.code)).length;

  const brokenBuckets: BrokenBucket[] = staffed
    .filter((d) => slotCountByCode.get(d.code) === 0)
    .map((d) => ({ code: d.code, effectiveDepth: d.effectiveDepth, slots: 0 }))
    .sort((a, b) => b.effectiveDepth - a.effectiveDepth || a.code.localeCompare(b.code));

  // Buckets we could actually judge (present agents AND a known slot count).
  const judgedCount = staffed.filter((d) => slotCountByCode.has(d.code)).length;

  const base = { staffedCount: judgedCount, brokenBuckets, unknownCount };

  // The whole cache is gone while agents are present: the booker can offer nothing.
  if (staffed.length > 0 && slotCountByCode.size === 0) {
    return { healthy: false, httpStatus: 503, reason: "cache_absent", ...base };
  }

  const strongBroken = brokenBuckets.some((b) => b.effectiveDepth >= thresholds.strongAgentFloor);
  if (strongBroken) {
    return { healthy: false, httpStatus: 503, reason: "tier_broken", ...base };
  }

  const systemic =
    judgedCount > 0 &&
    brokenBuckets.length >= thresholds.systemicMinBroken &&
    brokenBuckets.length / judgedCount >= thresholds.systemicFraction;
  if (systemic) {
    return { healthy: false, httpStatus: 503, reason: "systemic_empty", ...base };
  }

  return { healthy: true, httpStatus: 200, reason: "ok", ...base };
}

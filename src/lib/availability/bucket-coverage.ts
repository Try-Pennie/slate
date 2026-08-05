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
    `Booking bucket ${code} has NO eligible bookable agents and cannot ` +
    `route a lead. Check its agent attributes, bookable flags, and schedules ` +
    `before customers hit it.`
  );
}

/**
 * At or above this many dead buckets in one sweep, the cause is treated as ONE
 * systemic thing and pages once for the set (L36: aggregate during a broad
 * outage). Below it, each bucket keeps its own page, which is what the per-bucket
 * key was for: two dead zones must never suppress each other.
 *
 * Five is the line because one to four dead buckets is a staffing or criteria
 * problem in those specific buckets, and the per-bucket page names the thing to
 * fix. Five at once has never been five separate causes; on 2026-08-04 it was
 * sixty buckets sharing one (#1272: nobody in the roster was bookable), and sixty
 * identical pages every six hours is how a pager gets muted.
 */
export const AGGREGATE_EMPTY_THRESHOLD = 5;

/**
 * The key suffix the aggregate page rides on (`empty_buckets:all`), so it lives in
 * the same throttled-alert family as the per-bucket pages and needs no new catalog
 * entry. Bucket codes are the 3-digit XBC codes, so this can never collide with a
 * real bucket and can never clear one's page by accident.
 */
export const AGGREGATE_BUCKET_CODE = "all";

/** What one sweep should send, once the coverage is measured. */
export interface EmptyBucketPlan {
  /** True when this sweep pages ONCE for the whole set instead of once per bucket. */
  aggregated: boolean;
  /** Buckets to page on their own key (empty when aggregating). */
  pageCodes: string[];
  /**
   * Buckets whose own page must be dropped WITHOUT posting an all-clear, because
   * the aggregate page supersedes it. Posting sixty all-clears to announce that
   * sixty pages have been folded into one is the same flood wearing a hat.
   */
  settleCodes: string[];
  /** Buckets MEASURED healthy this sweep, so their page may be cleared normally. */
  clearCodes: string[];
}

/**
 * Decide the shape of one sweep's alerting from its measured coverage. Pure, so
 * the threshold behaviour is node-testable without a DB or Slack.
 */
export function planEmptyBucketAlerts(coverage: BucketCoverage[]): EmptyBucketPlan {
  const empty = emptyBuckets(coverage);
  // `> 0`, not `!== 0`: a nonsense negative count is not evidence of health.
  const clearCodes = coverage.filter((b) => b.eligibleCount > 0).map((b) => b.code);
  // Every bucket dead is systemic at any roster size, so it aggregates below the
  // threshold too. A one-bucket org is excluded: one page is already one page.
  const allDead = coverage.length >= 2 && empty.length === coverage.length;
  const aggregated = empty.length >= AGGREGATE_EMPTY_THRESHOLD || allDead;
  return {
    aggregated,
    pageCodes: aggregated ? [] : empty,
    settleCodes: aggregated ? empty : [],
    clearCodes,
  };
}

/**
 * The one page that replaces the per-bucket flood.
 *
 * It has to answer the question sixty identical lines could not: how widespread
 * is this, and is the cause the roster or these buckets' own configuration. So it
 * names the count and the bookable-agent count it MEASURED, and when that count
 * could not be read it says so rather than presenting an unreadable value as zero
 * (L11: a message may claim only what its check measured).
 */
export function emptyBucketsAggregateMessage(
  emptyCount: number,
  totalBuckets: number,
  bookableAgents: number | null,
): string {
  const head =
    `${emptyCount} of ${totalBuckets} booking buckets have no eligible bookable agent ` +
    `and cannot route a lead.`;
  let cause: string;
  if (bookableAgents === null) {
    cause =
      " The bookable agent count could not be read, so the cause is not established here. " +
      "Check agent bookable flags, bucket criteria, and schedules.";
  } else if (bookableAgents === 0) {
    cause =
      " No agent in the roster is bookable right now, which accounts for all of them. " +
      "Nothing can route anywhere until agents are switched back on.";
  } else {
    const who = bookableAgents === 1 ? "1 agent is bookable" : `${bookableAgents} agents are bookable`;
    cause =
      ` ${who}, so look at these buckets' criteria, their agents' bookable flags, ` +
      `and their schedules rather than the roster as a whole.`;
  }
  return `${head}${cause} Each bucket's own page is folded into this one.`;
}

/**
 * The all-clear for the aggregate (#1151: a condition owes the reader an end).
 *
 * Two genuinely different endings, and they must not read alike: every bucket can
 * route again, or the outage is no longer systemic while some buckets are still
 * dead and about to page on their own. Calling the second one "all clear" would be
 * the false-recovery defect (#1134).
 */
export function emptyBucketsAggregateRecoveredMessage(
  stillEmpty: number,
  totalBuckets: number,
): string {
  if (stillEmpty === 0) {
    return (
      `All ${totalBuckets} booking buckets can route leads again. The earlier page about ` +
      `them having nobody to route to is cleared. No action is needed.`
    );
  }
  const what =
    stillEmpty === 1 ? `1 of ${totalBuckets} buckets is` : `${stillEmpty} of ${totalBuckets} buckets are`;
  return (
    `The routing outage across the booking buckets is over, but ${what} still empty ` +
    `and will page individually from here. No lead can reach those yet.`
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
    `Booking bucket ${code} can route leads again (${who}). The earlier page about it ` +
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
    `A booking just failed because ${where} has NO eligible bookable agents ` +
    `to route to. A lead could not be booked. Check the bucket's agent attributes, ` +
    `bookable flags, and schedules.`
  );
}

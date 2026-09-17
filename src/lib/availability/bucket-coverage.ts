import { tierLadder } from "@/lib/routing/tiers";

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
  /**
   * The POOL this bucket routes through (#2237). Sixty codes resolve to fifteen
   * pools, so a tier with nobody in it is ONE finding that used to arrive as six
   * near identical pages, none of which named the thing to fix.
   *
   * Required, not optional, so `tsc` names every construction site rather than
   * letting one quietly fall back to per code pages.
   */
  poolKey: string;
  /** The pool in words, or null when its criteria are not the routing matrix. */
  poolLabel: string | null;
}

/**
 * Bucket codes that route to NO eligible agent: a dead zone.
 *
 * Judged across the code's TIER LADDER, not the code alone (#2483), and the
 * ladder is asked rather than re-derived here (L107) so this can never claim a
 * rescue the router does not perform.
 *
 * Per code, the Low plus Beyond codes 120, 121 and 122 are empty by
 * construction: no Low agent carries the Beyond backend. Since #1909 a Beyond
 * lead overflows sideways to Achieve, so `tierLadder("120")` is `120, 130` and a
 * lead on 120 is served by the whole Low Achieve pool. Judging per code made the
 * hourly page and the flip morning readiness gate both red about three buckets
 * that are correct, on the healthy day, which is how a gate stops being read
 * (L36). `empty_buckets:120` was firing in production when this shipped.
 *
 * THE LADDER, NOT THE DEBT TIER, and the difference is a fail open. Codes 111 and
 * 112 share a tier, a backend and a pool, so "its tier has somebody" reads as
 * coverage; `tierLadder("111")` is `["111"]`, because the ladder drops tiers and
 * does not walk sideways except for the Beyond overflow. A lead on 111 whose pool
 * is empty is not booked by 112's hand named member, which is exactly the silence
 * #2253 was opened about. Asking the ladder makes the claim true by construction,
 * and means a future ladder (#2486 widens it to cross a tier before dropping one)
 * moves this with it rather than leaving two rules to keep in step.
 *
 * What this does NOT report, deliberately: a whole debt tier with nobody in it
 * while a lower tier is staffed. That is a real thing to know and it is not a
 * dead end, because the lead IS booked, one or more rungs down. It belongs to the
 * surfaces that can say how far the lead fell and how thin the tier is,
 * `tierFallbackAlert` and the staffing depth page, rather than to an alarm whose
 * sentence is "cannot route a lead".
 *
 * A count is read as staffing only when it is `> 0`: a nonsense negative is not
 * evidence of health, the same reading `planEmptyBucketAlerts` takes.
 */
export function emptyBuckets(coverage: BucketCoverage[]): string[] {
  const staffed = new Set(coverage.filter((b) => b.eligibleCount > 0).map((b) => b.code));
  return coverage
    .filter((b) => b.eligibleCount === 0)
    // A rung absent from the coverage is no rescue: it is a code this sweep never
    // measured, and an unmeasured rung reading as a staffed one is the same fail
    // open in a second costume.
    .filter((b) => !tierLadder(b.code).some((rung) => staffed.has(rung)))
    .map((b) => b.code);
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

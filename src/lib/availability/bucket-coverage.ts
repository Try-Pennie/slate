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

/** A pool as the alerting decides about it. */
export interface CoveragePool {
  key: string;
  label: string | null;
  /** Every bucket code in the pool, ascending. */
  codes: string[];
  /**
   * The code the pool's page rides on, so the whole family stays under the
   * existing `empty_buckets:<code>` key space and needs no catalog entry.
   *
   * The LOWEST code, so it is the same on every sweep whatever order the rows
   * arrive in. An unstable key would page under a new name each time and never
   * clear the old one: the throttle failing open in the noisiest way there is.
   */
  representative: string;
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

/** Every pool in the coverage, ascending by code, whether empty or not. */
function poolsOf(coverage: BucketCoverage[]): CoveragePool[] {
  const byKey = new Map<string, BucketCoverage[]>();
  for (const row of coverage) {
    const group = byKey.get(row.poolKey);
    if (group) group.push(row);
    else byKey.set(row.poolKey, [row]);
  }
  return [...byKey.entries()].map(([key, rows]) => {
    const codes = rows.map((r) => r.code).sort();
    return {
      key,
      // Taken from the first row rather than demanded to agree: every row in a
      // pool is handed the same label by construction, and disagreeing about a
      // DISPLAY string is not worth refusing to page about an empty pool.
      label: rows[0]!.poolLabel,
      codes,
      representative: codes[0]!,
    };
  });
}

/**
 * The POOLS that route to nobody (#2237).
 *
 * This is what the aggregate counts now. A pool is empty when every code in it
 * is, which is how the data always behaves (the codes share one set of criteria,
 * so they resolve the same agents); the `every` is what keeps a partly empty pool
 * from being reported as a dead one.
 */
export function emptyPools(coverage: BucketCoverage[]): CoveragePool[] {
  const empty = new Set(emptyBuckets(coverage));
  return poolsOf(coverage).filter((p) => p.codes.every((c) => empty.has(c)));
}

/**
 * Per-bucket proactive-alert text. The sweep sends ONE throttled alert per dead
 * bucket (keyed by code) rather than a single combined alert, so two buckets
 * going empty close together each surface under their own throttle instead of
 * the second being suppressed by a shared key.
 */
export function emptyBucketMessage(pool: CoveragePool): string {
  // The pool is what a person fixes (its criteria select the agents), and the
  // CODES are what the landing pages send, so the message carries both: a reader
  // told only "the Low pool" cannot check a booking link, and one told only "100"
  // does not know the other five are affected too (L679).
  const who = pool.label ? `The ${pool.label} pool` : "A booking pool";
  const codes =
    pool.codes.length === 1
      ? `bucket ${pool.codes[0]}`
      : `buckets ${pool.codes.join(", ")}`;
  return (
    `${who} has NO eligible bookable agents and cannot route a lead. It serves ` +
    `${codes}, so every one of those booking links is affected. Check the pool's ` +
    `agent attributes, bookable flags, and schedules before customers hit it.`
  );
}

/**
 * At or above this many dead buckets in one sweep, the cause is treated as ONE
 * systemic thing and pages once for the set (L36: aggregate during a broad
 * outage). Below it, each bucket keeps its own page, which is what the per-bucket
 * key was for: two dead zones must never suppress each other.
 *
 * Five is the line because one to four dead pools is a staffing or criteria
 * problem in those specific pools, and the per-pool page names the thing to fix.
 * Five at once has never been five separate causes; on 2026-08-04 it was sixty
 * buckets sharing one (#1272: nobody in the roster was bookable), and sixty
 * identical pages every six hours is how a pager gets muted.
 *
 * It counts POOLS since #2237, and that re-aimed it rather than left it alone
 * (L220). Five of sixty CODES was reached by a single unstaffed tier, which is
 * one staffing problem and exactly the case the per bucket page was written for.
 * Five of fifteen POOLS is a third of the routing matrix, which is the systemic
 * thing this was always meant to catch. The number is the same and the question
 * it asks is not.
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
  /** True when this sweep pages ONCE for the whole set instead of once per pool. */
  aggregated: boolean;
  /** Pools to page, each on its representative's key (empty when aggregating). */
  pagePools: CoveragePool[];
  /**
   * Codes whose own page must be dropped WITHOUT posting an all-clear, because a
   * page that supersedes it has already been sent: the aggregate, or the page for
   * the pool they belong to. Posting sixty all-clears to announce that sixty pages
   * have been folded into one is the same flood wearing a hat.
   */
  settleCodes: string[];
  /**
   * Codes MEASURED healthy this sweep, so their page may be cleared normally,
   * each carrying its pool so the all-clear can name what the page named.
   *
   * Still per CODE rather than per pool: a page sent before #2237 rides on its
   * own code's key, and nothing else would ever clear it.
   */
  clear: {
    code: string;
    pool: CoveragePool;
    eligibleCount: number;
    /**
     * True when this code has nobody of its own and is covered by its debt tier
     * (#2483). It clears a page rather than sending one, and it owes a DIFFERENT
     * sentence: `recoveredBucketMessage` names the eligible agents it has, which
     * for these is still zero, and saying otherwise is the false recovery defect
     * (#1134).
     */
    tierCovered: boolean;
  }[];
}

/**
 * Decide the shape of one sweep's alerting from its measured coverage. Pure, so
 * the threshold behaviour is node-testable without a DB or Slack.
 */
export function planEmptyBucketAlerts(coverage: BucketCoverage[]): EmptyBucketPlan {
  const pools = poolsOf(coverage);
  const dead = emptyPools(coverage);
  const byKey = new Map(pools.map((p) => [p.key, p]));

  // `> 0`, not `!== 0`: a nonsense negative count is not evidence of health.
  //
  // A code with nobody of its own that its DEBT TIER covers is cleared too
  // (#2483), because the sweep has stopped paging about it and a page nobody is
  // told has ended is one somebody is still carrying (#1151). It is marked so the
  // all-clear can say which of the two endings this is.
  const deadCodes = new Set(emptyBuckets(coverage));
  const clear = coverage
    .filter((b) => b.eligibleCount > 0 || !deadCodes.has(b.code))
    .map((b) => ({
      code: b.code,
      pool: byKey.get(b.poolKey)!,
      eligibleCount: b.eligibleCount,
      tierCovered: b.eligibleCount <= 0,
    }));

  // Every pool dead is systemic at any roster size, so it aggregates below the
  // threshold too. A one-pool org is excluded: one page is already one page.
  const allDead = pools.length >= 2 && dead.length === pools.length;
  const aggregated = dead.length >= AGGREGATE_EMPTY_THRESHOLD || allDead;

  // When a pool pages, the codes it SPEAKS FOR are settled rather than paged:
  // one finding, one page. The representative is not settled, because that is
  // the key the page itself rides on.
  const settleCodes = aggregated
    ? dead.flatMap((p) => p.codes)
    : dead.flatMap((p) => p.codes.filter((c) => c !== p.representative));

  return {
    aggregated,
    pagePools: aggregated ? [] : dead,
    settleCodes,
    clear,
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
  totalPools: number,
  bookableAgents: number | null,
): string {
  const what =
    emptyCount === 1
      ? `1 of ${totalPools} routing pools has`
      : `${emptyCount} of ${totalPools} routing pools have`;
  const head = `${what} no eligible bookable agent and cannot route a lead.`;
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
      ` ${who}, so look at these pools' criteria, their agents' bookable flags, ` +
      `and their schedules rather than the roster as a whole.`;
  }
  return `${head}${cause} Each pool's own page is folded into this one.`;
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
  totalPools: number,
): string {
  if (stillEmpty === 0) {
    return (
      `All ${totalPools} routing pools can route leads again. The earlier page about ` +
      `them having nobody to route to is cleared. No action is needed.`
    );
  }
  const what =
    stillEmpty === 1 ? `1 of ${totalPools} pools is` : `${stillEmpty} of ${totalPools} pools are`;
  return (
    `The routing outage across the booking pools is over, but ${what} still empty ` +
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
export function recoveredBucketMessage(pool: CoveragePool, eligibleCount: number): string {
  const who = eligibleCount === 1 ? "1 eligible bookable agent" : `${eligibleCount} eligible bookable agents`;
  // Named the way the page named it (#2237), or the reader is told one bucket
  // recovered after being told six were affected.
  const what = pool.label
    ? `The ${pool.label} pool`
    : `Booking bucket ${pool.codes.join(", ")}`;
  return (
    `${what} can route leads again (${who}). The earlier page about it ` +
    `having nobody to route to is cleared. No action is needed.`
  );
}

/**
 * The all-clear for a bucket whose DEBT TIER covers it (#2483).
 *
 * The other ending, and it must not read like `recoveredBucketMessage`: nobody
 * was staffed onto this bucket and nobody is going to be. What changed is the
 * question being asked, from "does this code have agents" to "does its tier", so
 * the sentence says that rather than announcing a recovery that did not happen.
 */
export function tierCoveredBucketMessage(pool: CoveragePool): string {
  const what = pool.label ? `The ${pool.label} pool` : "A booking pool";
  const codes =
    pool.codes.length === 1 ? `bucket ${pool.codes[0]}` : `buckets ${pool.codes.join(", ")}`;
  return (
    `${what} has nobody of its own, and its debt tier does, so a lead on ${codes} ` +
    `is served there. This is expected rather than fixed: no agent was added. ` +
    `The earlier page about it having nobody to route to is cleared and will not ` +
    `return while the tier is staffed. No action is needed.`
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

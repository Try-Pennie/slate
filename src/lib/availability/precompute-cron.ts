/**
 * Pure ordering/staleness helpers for the cron backstop (Phase 3). The cron
 * recomputes buckets changed this tick FIRST, then rotates through the
 * least-recently-computed of the rest within its time budget — which also slides
 * the day-window forward for buckets whose agents didn't change. Kept pure so the
 * rotation + staleness logic is unit-testable.
 */

export interface KnownRow {
  code: string;
  computedAtMs: number;
}

/**
 * Recompute order: `touched` buckets first (in the given order), then every other
 * known/all bucket ordered least-recently-computed first (never-computed = 0, so
 * they sort to the front). No duplicates. The caller recomputes in this order
 * until its budget runs out; the tail is picked up on later ticks.
 */
export function orderBucketsForRecompute(
  touched: string[],
  known: KnownRow[],
  allCodes: string[],
): string[] {
  const computedAt = new Map(known.map((k) => [k.code, k.computedAtMs]));
  const seen = new Set(touched);
  const rest = allCodes
    .filter((c) => !seen.has(c))
    .sort((a, b) => (computedAt.get(a) ?? 0) - (computedAt.get(b) ?? 0));
  return [...touched, ...rest];
}

/** Buckets that are never-computed or older than `staleMs` (for the alert). */
export function staleBuckets(
  known: KnownRow[],
  allCodes: string[],
  nowMs: number,
  staleMs: number,
): string[] {
  const computedAt = new Map(known.map((k) => [k.code, k.computedAtMs]));
  return allCodes.filter((c) => {
    const at = computedAt.get(c);
    return at === undefined || nowMs - at > staleMs;
  });
}

/**
 * Buckets the cron should recompute this run (#294): only those never-computed
 * or older than `freshMs`, oldest-first (never-computed sorts first). The cron
 * no longer force-recomputes every bucket every minute — real-time push/booking
 * keep changed buckets fresh; this lane just covers the day-window slide and the
 * missed-push backstop, so it only re-derives buckets aging past the freshness
 * window. Keeps work bounded and scalable.
 */
export function bucketsDueForRecompute(
  known: KnownRow[],
  allCodes: string[],
  nowMs: number,
  freshMs: number,
): string[] {
  const computedAt = new Map(known.map((k) => [k.code, k.computedAtMs]));
  return allCodes
    .filter((c) => {
      const at = computedAt.get(c);
      return at === undefined || nowMs - at > freshMs;
    })
    .sort((a, b) => (computedAt.get(a) ?? 0) - (computedAt.get(b) ?? 0));
}

export interface RecomputeHeadroom {
  /** Run time as a percentage of the per-tick budget (for logs/observability). */
  utilizationPct: number;
  /** Whether the run recomputed every bucket that was due (didn't run out of budget). */
  drained: boolean;
  /**
   * True ONLY when the lane could not drain its due set within budget, i.e. it
   * is genuinely falling behind. A fully-drained cycle is keeping up and never
   * warns, no matter how much of the budget it used: a high-but-drained cycle
   * (e.g. a one-off post-deploy catch-up) is not actionable and alerting on it
   * is just noise. The route adds a consecutive-cycle streak on top so even a
   * single behind cycle stays quiet until it persists.
   */
  warn: boolean;
}

/**
 * Headroom for the recompute lane (#294 follow-up). `utilizationPct` is reported
 * for logs; `warn` fires only when the cycle failed to drain the due set within
 * budget. Pure so it's unit-tested; the route times the run and feeds it in.
 */
export function recomputeHeadroom(
  runMs: number,
  budgetMs: number,
  dueCount: number,
  recomputedCount: number,
): RecomputeHeadroom {
  const fraction = budgetMs > 0 ? runMs / budgetMs : 0;
  const drained = recomputedCount >= dueCount;
  return {
    utilizationPct: Math.round(fraction * 100),
    drained,
    warn: !drained,
  };
}

/**
 * Drain the due-bucket set in BOUNDED-CONCURRENCY waves within the time budget.
 * The recompute is DB-only (reads the busy_blocks cache + schedules, no live
 * Google), so several buckets recompute safely at once — which keeps the lane
 * draining the due set at fleet scale (#297) instead of the old one-at-a-time
 * loop that fell ~1 bucket behind per cycle once ~110 agents were live.
 *
 * Budget is checked BEFORE each wave (so it never overruns by more than one
 * wave), and a single bucket's failure is isolated (logged, not counted) rather
 * than aborting the whole cycle. Returns how many buckets were refreshed. Pure
 * (injected `recompute` + `withinBudget`) so it's unit-tested without IO.
 */
export async function recomputeDueBuckets(
  due: string[],
  recompute: (code: string) => Promise<void>,
  withinBudget: () => boolean,
  concurrency: number,
): Promise<number> {
  let recomputed = 0;
  for (let i = 0; i < due.length; i += concurrency) {
    if (!withinBudget()) break;
    const wave = due.slice(i, i + concurrency);
    const results = await Promise.allSettled(wave.map((code) => recompute(code)));
    results.forEach((r, j) => {
      if (r.status === "fulfilled") {
        recomputed++;
      } else {
        console.error(
          `recompute failed for bucket ${wave[j]}: ${
            r.reason instanceof Error ? r.reason.message : r.reason
          }`,
        );
      }
    });
  }
  return recomputed;
}

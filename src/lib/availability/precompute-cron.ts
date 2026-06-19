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

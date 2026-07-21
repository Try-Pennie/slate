/**
 * Self-heal for availability DATA ANOMALIES (#573), a follow-up to #570.
 *
 * When the monitor classifies a bucket as a data anomaly (the cached slots show
 * NO times but a live recompute finds some, so the cache disagrees with the
 * agents' real calendars), it already holds the correct answer in that moment.
 * Rather than only paging and leaving customers on "no times" until a human
 * reacts, it rewrites the fresh row so the booker recovers immediately.
 *
 * Two guardrails keep this from masking a persistent fault:
 *   - it heals each bucket at most ONCE per window (the caller's `claim` is a
 *     DB-backed per-bucket lock that is NOT released, so a flapping bucket is not
 *     rewritten every minute), and
 *   - the caller STILL pages on every anomaly, so the root-cause sync/precompute
 *     bug gets fixed regardless of the auto-recovery.
 *
 * A heal that throws is reported (fail loud) and does not abort the other buckets.
 * Pure orchestration over injected deps, so it is unit-tested without DB or cron.
 */

export interface AnomalySelfHealDeps {
  /** Reserve the once-per-window heal slot for `code`. true = we may heal now;
   *  false = already healed this window (a held lock), so skip. */
  claim: (code: string) => Promise<boolean>;
  /** Recompute + rewrite the bucket's cached row and clear its L1 key. */
  heal: (code: string) => Promise<void>;
  /** Surface a heal failure (fail loud). Optional; defaults to a no-op. */
  onError?: (code: string, err: unknown) => void;
}

export interface SelfHealResult {
  /** Buckets whose cache was rewritten this run. */
  healed: string[];
  /** Buckets already healed this window (lock held), left for the alert to page. */
  skipped: string[];
  /** Buckets whose heal threw (still paged; root cause unresolved). */
  failed: string[];
}

export async function selfHealDataAnomalies(
  codes: string[],
  deps: AnomalySelfHealDeps,
): Promise<SelfHealResult> {
  const healed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const code of codes) {
    if (!(await deps.claim(code))) {
      skipped.push(code);
      continue;
    }
    try {
      await deps.heal(code);
      healed.push(code);
    } catch (err) {
      failed.push(code);
      deps.onError?.(code, err);
    }
  }

  return { healed, skipped, failed };
}

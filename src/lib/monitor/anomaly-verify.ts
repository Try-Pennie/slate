/**
 * Re-verify a suspected availability anomaly before paging anyone (#1167).
 *
 * The monitor classifies a dead-end bucket by comparing the cached slot count
 * against a live recompute, and it used to page on the FIRST tick where the two
 * disagreed. A disagreement can be momentary though: the read can land while the
 * recompute lane is mid-write, or a recompute can briefly answer wrong. That woke
 * on-call for a fault that had already fixed itself, which is the cry-wolf failure
 * mode that gets a real page ignored later.
 *
 * So a suspect bucket is re-checked a few more times, and only the ones that KEEP
 * disagreeing are confirmed. Re-verification runs BEFORE the self-heal, which is
 * what makes it possible at all: once the heal rewrites the cache the two sides
 * always agree, so there is nothing left to compare (that is why this is a
 * within-tick re-check rather than a streak across ticks, which the self-heal
 * would silently make unreachable).
 *
 * THE RISK THIS CARRIES is that it becomes a way to lose a real alert. A
 * verification that cannot run must never read as "no anomaly found", the same
 * trap as a swallowed error read collapsing to an empty list. Every inconclusive
 * path here therefore fails CLOSED, keeping the original finding so it still
 * pages: an unreadable cached row, a throwing read, a recompute that never
 * recovers, an exhausted tick deadline, and a broad anomaly it deliberately does
 * not spend the budget on. `scripts/test-monitor-anomaly-verify.ts` pins each one.
 *
 * Pure orchestration over injected deps (the shape `anomaly-selfheal.ts` uses),
 * with no `@/` imports, so the node suite drives every branch without a DB, a
 * clock, or a cron.
 */

/** What one re-check concluded about a bucket. */
type Observation = "anomaly" | "caughtUp" | "bookedSolid" | "unverified" | "inconclusive";

export interface AnomalyVerifyDeps {
  /** Buckets this tick classified as a data anomaly (cache empty, recompute found times). */
  dataAnomaly: string[];
  /** Buckets whose live recompute failed, so the cause was never established. */
  unverified: string[];
  /** Extra re-checks after the initial classification. 0 disables verification. */
  attempts: number;
  /** Pause before each re-check, giving an in-flight recompute time to land. */
  delayMs: number;
  /**
   * Above this many suspect buckets, skip verification and confirm everything. A
   * wide anomaly is an outage rather than a blip, so delaying it to re-check is
   * wrong on its own terms, and re-reading every bucket would spend a subrequest
   * budget this lane shares with three others.
   */
  maxBuckets: number;
  /** The tick's budget ceiling (real-clock epoch ms), as used by the scan. */
  deadlineMs: number;
  /** Real clock, injected so tests can place themselves either side of the deadline. */
  now: () => number;
  /** Fresh cached slot count for one bucket, or null when the row could not be read. */
  cachedSlots: (code: string) => Promise<number | null>;
  /** Live recompute slot count, or null when it failed. */
  recomputeSlots: (code: string) => Promise<number | null>;
  wait: (ms: number) => Promise<void>;
}

export interface AnomalyVerifyResult {
  /** Confirmed data anomalies: these heal and page. */
  dataAnomaly: string[];
  /** Still unverified after re-checking: these page, as they always did. */
  unverified: string[];
  /** Reclassified as genuinely booked solid: whispers on the info channel. */
  bookedSolid: string[];
  /** Suspicions that dissolved on re-check. Nobody is paged; the scan logs them. */
  resolved: string[];
  /** True when verification did not run at all (see `reason`). */
  skipped: boolean;
  reason?: string;
}

/** One re-check of a single bucket. Any failure is `inconclusive`, never a clean bill. */
async function observe(code: string, deps: AnomalyVerifyDeps): Promise<Observation> {
  let cached: number | null;
  try {
    cached = await deps.cachedSlots(code);
  } catch {
    return "inconclusive";
  }
  // A row we could not read is not evidence the cache is healthy.
  if (cached === null) return "inconclusive";
  // The cache now has times, so the booker is serving them and there is no
  // dead-end left to explain.
  if (cached > 0) return "caughtUp";
  let recomputed: number | null;
  try {
    recomputed = await deps.recomputeSlots(code);
  } catch {
    return "inconclusive";
  }
  if (recomputed === null) return "unverified";
  // Cache and calendars agree that there is nothing free: a capacity fact.
  if (recomputed === 0) return "bookedSolid";
  return "anomaly";
}

/**
 * Re-check every suspect bucket up to `attempts` times and report what survives.
 *
 * A bucket leaves the suspect set only on a POSITIVE finding (`caughtUp` or
 * `bookedSolid`). An `anomaly`, an `unverified`, or an `inconclusive` observation
 * keeps it in doubt for the next round, and whatever it last looked like is what
 * it is confirmed as, so a bucket whose recompute recovers mid-verification gets
 * the classification it actually earned instead of the one it arrived with.
 */
export async function verifyAnomalies(deps: AnomalyVerifyDeps): Promise<AnomalyVerifyResult> {
  const suspects = [...deps.dataAnomaly, ...deps.unverified];
  // What each suspect is currently believed to be, seeded from this tick's
  // classification so an un-rechecked bucket keeps its original verdict.
  const belief = new Map<string, Observation>([
    ...deps.dataAnomaly.map((c) => [c, "anomaly"] as const),
    ...deps.unverified.map((c) => [c, "unverified"] as const),
  ]);

  const confirm = (skipped: boolean, reason?: string): AnomalyVerifyResult => {
    const result: AnomalyVerifyResult = {
      dataAnomaly: [],
      unverified: [],
      bookedSolid: [],
      resolved: [],
      skipped,
    };
    if (reason !== undefined) result.reason = reason;
    for (const code of suspects) {
      switch (belief.get(code)) {
        case "caughtUp":
          result.resolved.push(code);
          break;
        case "bookedSolid":
          result.bookedSolid.push(code);
          break;
        case "unverified":
          result.unverified.push(code);
          break;
        default:
          // "anomaly" and "inconclusive" both fail closed to a paging finding.
          result.dataAnomaly.push(code);
      }
    }
    return result;
  };

  if (suspects.length === 0) return confirm(false);
  if (deps.attempts <= 0) return confirm(true, "verification disabled");
  if (suspects.length > deps.maxBuckets) {
    return confirm(true, `broad anomaly (${suspects.length} buckets), paging without re-verification`);
  }
  if (deps.now() >= deps.deadlineMs) {
    return confirm(true, "past the tick deadline");
  }

  // Still in doubt. Settled buckets drop out, so a resolved blip does not burn
  // the remaining attempts.
  let inDoubt = [...suspects];
  for (let round = 0; round < deps.attempts && inDoubt.length > 0; round++) {
    if (deps.now() >= deps.deadlineMs) break;
    await deps.wait(deps.delayMs);
    // Suspects are capped at maxBuckets, so this fans out at most that wide.
    const seen = await Promise.all(
      inDoubt.map(async (code) => ({ code, observation: await observe(code, deps) })),
    );
    const stillInDoubt: string[] = [];
    for (const { code, observation } of seen) {
      // An inconclusive read teaches nothing, so it must not overwrite what we
      // already believe (a real anomaly seen last round stays an anomaly).
      if (observation !== "inconclusive") belief.set(code, observation);
      if (observation === "caughtUp" || observation === "bookedSolid") continue;
      stillInDoubt.push(code);
    }
    inDoubt = stillInDoubt;
  }

  return confirm(false);
}

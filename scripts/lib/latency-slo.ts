/**
 * The canary's latency verdict (#1047), pure.
 *
 * The canary proves the funnel WORKS. It says nothing about whether it is fast, and
 * the one latency number anybody quotes (a warm availability read at about 39ms, #256)
 * is a point-in-time measurement from the day the precompute shipped. So a latency
 * regression relies on somebody noticing a page feels slow, which for a lead who
 * abandons is nobody.
 *
 * The design decisions here are about not creating a flapping alert, because an alert
 * that cries wolf gets ignored (L36) and a latency check is the classic source of one:
 *
 *   - it judges the MEDIAN of several samples, not one request. A single cold isolate,
 *     or one unlucky sample, is not a regression.
 *   - the first sample is DISCARDED, always. The first request to a Worker after an
 *     idle period pays isolate startup, and measuring that measures how quiet the
 *     morning was rather than how fast the endpoint is.
 *   - the threshold is deliberately far above the measured warm number. This is a
 *     regression detector, not a performance target: at 39ms warm, a 500ms median
 *     means something structural changed (a cache miss on every read, a live Google
 *     call that should not be there), not that a datacenter was busy.
 */

/** Samples to take. Enough that the median is not one request, few enough to be free. */
export const LATENCY_SAMPLES = 5;

/**
 * The median that counts as a regression, in milliseconds.
 *
 * An order of magnitude above the ~39ms warm read, on purpose. What this catches is a
 * cache-first read that has stopped being cache-first, which is the failure that
 * matters and which shows up as hundreds of milliseconds, not tens.
 */
export const AVAILABILITY_P50_BUDGET_MS = 500;

export interface LatencyVerdict {
  /** The median of the kept samples, or null when there was nothing to judge. */
  medianMs: number | null;
  /** True only when a median was measured AND it exceeded the budget. */
  regressed: boolean;
  /** One sentence for the failure log, or null when there is nothing to say. */
  message: string | null;
}

/** The middle value, or the mean of the two middles. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Judge a run's samples.
 *
 * `samples` is in the order they were taken; the first is dropped as the cold one.
 *
 * A run with nothing to judge reports `regressed: false` and SAYS so in the message
 * rather than silently passing: "measured nothing" and "measured a healthy number"
 * must not look the same to the reader (L98). It is not a failure, because a canary
 * that could not reach the endpoint at all already fails on the availability check
 * itself, and failing twice for one cause is how an alert stops naming its cause.
 */
export function judgeLatency(
  samples: number[],
  budgetMs: number = AVAILABILITY_P50_BUDGET_MS,
): LatencyVerdict {
  const kept = samples.slice(1).filter((n) => Number.isFinite(n) && n >= 0);
  const medianMs = median(kept);
  if (medianMs === null) {
    return {
      medianMs: null,
      regressed: false,
      message:
        "latency was not measured this run (no usable samples), so this pass says nothing about it",
    };
  }
  if (medianMs > budgetMs) {
    return {
      medianMs,
      regressed: true,
      message:
        `availability read median ${Math.round(medianMs)}ms over ${kept.length} samples, past the ` +
        `${budgetMs}ms budget. That is an order of magnitude above the warm cached read, so look ` +
        `for a read that has stopped being served from the cache rather than for a slow datacenter.`,
    };
  }
  return { medianMs, regressed: false, message: null };
}

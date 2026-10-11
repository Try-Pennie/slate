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

/**
 * How long to wait before re-measuring a batch that came in over budget (#2811).
 *
 * Measured, not chosen: 590 canary runs from 2026-09-11 to 2026-09-26 went over budget
 * 10 times, and the NEXT run after every one of them read between 38ms and 204ms. The
 * slow stretches inside those runs span a few seconds (one batch's five requests), so a
 * two minute pause outlasts every one on record while keeping the job far inside its
 * 15 minute timeout. It is paid only on the rare over-budget batch, never on a healthy run.
 */
export const LATENCY_RECHECK_DELAY_MS = 2 * 60_000;

/**
 * What one canary pass concluded about latency, after any recheck.
 *
 *  - `not-measured`        the first batch had nothing to judge. Not a page, and not a
 *                          measured reading either, so it stamps no verdict (#1700).
 *  - `healthy`             the first batch was inside the budget.
 *  - `passing-blip`        over budget, then inside it on the recheck. Logged, not paged.
 *  - `confirmed`           over budget on both batches. Pages.
 *  - `recheck-unmeasured`  over budget, and the recheck got no usable readings. Pages,
 *                          because the only thing known is that the read was slow.
 */
export type LatencyRunKind =
  | "not-measured"
  | "healthy"
  | "passing-blip"
  | "confirmed"
  | "recheck-unmeasured";

export interface LatencyRun {
  kind: LatencyRunKind;
  /** True when this pass must page. */
  page: boolean;
  /** True when a real median was read, pass or fail: the #1700 verdict stamp. */
  measured: boolean;
  /** One sentence for the log, and for the failure log when `page` is true. */
  message: string | null;
  first: LatencyVerdict;
  recheck: LatencyVerdict | null;
}

export interface LatencyRunDeps {
  /** Take one batch of `LATENCY_SAMPLES` timed reads, in order, errors left out. */
  takeBatch: () => Promise<number[]>;
  /** Injected so a test never waits for real (L524). */
  sleep: (ms: number) => Promise<void>;
  budgetMs?: number;
  recheckDelayMs?: number;
}

const ms = (n: number | null) => `${Math.round(n ?? 0)}ms`;

/**
 * Measure, and re-measure once before paging (#2811).
 *
 * One slow batch paged on its own before this, and in the whole recorded history that
 * was never the start of a real regression. A cache-first read that has stopped being
 * cache-first is slow on EVERY read, so it is slow on the recheck too and still pages
 * in the same run.
 */
export async function measureLatency(deps: LatencyRunDeps): Promise<LatencyRun> {
  const budgetMs = deps.budgetMs ?? AVAILABILITY_P50_BUDGET_MS;
  const delayMs = deps.recheckDelayMs ?? LATENCY_RECHECK_DELAY_MS;
  const first = judgeLatency(await deps.takeBatch(), budgetMs);
  if (first.medianMs === null) {
    return { kind: "not-measured", page: false, measured: false, message: first.message, first, recheck: null };
  }
  if (!first.regressed) {
    return { kind: "healthy", page: false, measured: true, message: null, first, recheck: null };
  }
  await deps.sleep(delayMs);
  const recheck = judgeLatency(await deps.takeBatch(), budgetMs);
  const wait = `${Math.round(delayMs / 60_000)} minutes`;
  if (recheck.medianMs === null) {
    return {
      kind: "recheck-unmeasured",
      page: true,
      measured: true,
      message:
        `availability read median ${ms(first.medianMs)}, past the ${budgetMs}ms budget, and it could not be ` +
        `re-measured ${wait} later (no usable readings), so it cannot be ruled a passing blip. Look for a read ` +
        `that has stopped being served from the cache, and at whether the endpoint is answering at all.`,
      first,
      recheck,
    };
  }
  if (!recheck.regressed) {
    return {
      kind: "passing-blip",
      page: false,
      measured: true,
      message:
        `availability read median ${ms(first.medianMs)} was past the ${budgetMs}ms budget, and ` +
        `${ms(recheck.medianMs)} on a recheck ${wait} later, so it was a slow minute and nobody is paged.`,
      first,
      recheck,
    };
  }
  return {
    kind: "confirmed",
    page: true,
    measured: true,
    message:
      `availability read median ${ms(first.medianMs)}, and ${ms(recheck.medianMs)} again on a recheck ${wait} ` +
      `later, both past the ${budgetMs}ms budget. That is an order of magnitude above the warm cached read and ` +
      `it did not pass, so look for a read that has stopped being served from the cache rather than for a slow ` +
      `datacenter.`,
    first,
    recheck,
  };
}

/** The verdict for one canary pass that probed a real bucket AND the SMOKE bucket. */
export interface DualLatencyDecision {
  /** True when this pass must page (a confirmed REAL-bucket regression). */
  page: boolean;
  /** True when the REAL bucket read a median, pass or fail: the #1700 verdict stamp. */
  measured: boolean;
  /** One sentence for the log, and for the failure log when `page` is true. */
  message: string | null;
}

/**
 * Combine a full REAL-bucket run with a one-batch SMOKE reading into the pass's
 * verdict (#3586).
 *
 * The SMOKE bucket is the one the canary books and cancels on every pass, so its slot
 * cache is churned and a cold SMOKE read can be slow while a real lead is unaffected
 * (2026-10-10: a ~3 minute SMOKE blip paged as a production slowdown). So paging and the
 * verdict stamp follow the REAL bucket, whose cache the canary never touches and which
 * is what a lead actually reads; the SMOKE reading is kept only as a comparison in the
 * log, so a churned-test-cache blip is visible but never pages.
 *
 * The REAL bucket drives `measured` too: if it read no median (a renamed bucket code, or
 * the endpoint not answering), this pass stamps nothing, so the `verdict:availability-latency`
 * heartbeat goes stale and pages through the #1700 net rather than a dead real probe
 * reading as a healthy morning (L557). The SMOKE reading never rescues that: it is not
 * the signal being protected.
 */
export function decideDualLatency(
  real: LatencyRun,
  smoke: LatencyVerdict,
  realBucket: string,
): DualLatencyDecision {
  const smokeNote =
    smoke.medianMs === null
      ? "SMOKE bucket not measured"
      : `SMOKE bucket median ${Math.round(smoke.medianMs)}ms`;
  // Every message names the REAL bucket it is about: it is the subject of the page now,
  // so "availability read median Nms" without a bucket, next to only a SMOKE note, would
  // read as if SMOKE were what regressed.
  const realNote = `real bucket ${realBucket}`;
  if (real.page) {
    return {
      page: true,
      measured: real.measured,
      message: real.message ? `${real.message} (${realNote}; ${smokeNote})` : `${realNote}; ${smokeNote}`,
    };
  }
  if (!real.measured) {
    // The production signal measured nothing; no page this pass, and no stamp, so a
    // persistently broken real probe is caught by the stale heartbeat, not swallowed.
    return {
      page: false,
      measured: false,
      message: real.message ? `${real.message} (${realNote}; ${smokeNote})` : `${realNote}; ${smokeNote}`,
    };
  }
  if (smoke.regressed) {
    // The real bucket's HEALTHY median is the recheck's when the first batch was a
    // passing blip (first over budget, recheck inside it); only on a clean `healthy`
    // run is `first` the in-budget reading. Reporting `first` here would print the
    // slow number beside the words "inside the budget".
    const realHealthyMs = real.recheck?.medianMs ?? real.first.medianMs;
    return {
      page: false,
      measured: true,
      message:
        `${realNote} median ${ms(realHealthyMs)} is inside the budget; ${smokeNote} was over it, so a ` +
        `churned test-cache blip and not a production slowdown. Nobody is paged.`,
    };
  }
  return { page: false, measured: true, message: real.message };
}

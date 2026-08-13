/**
 * One bounded retry, shared by the gates that were failing for reasons unrelated
 * to what they check (#1437 the migration drift gate, #1210 the static asset
 * probe).
 *
 * Why it is shared rather than two inline loops: a retry is a change to what a
 * gate MEANS, so the rule that keeps it honest has to live somewhere a suite can
 * reach it. Two hand rolled loops in two `run:` blocks would each be a rule
 * nothing can test, which is the same objection that moved the drift parse out of
 * YAML in #1433.
 *
 * The three properties that make a retry safe to add to a gate:
 *
 *   1. **Exhaustion is still a failure.** Running out of attempts returns
 *      `ok: false` with the last reason AND the attempt count, so a reader can
 *      tell a one off blip from a dead upstream. It can never come back ok.
 *   2. **The caller decides what is retryable.** This module never inspects the
 *      value, so "answered, badly" (a 404, a real drift finding) is an ANSWER and
 *      is not retried: a retry there would only delay the same verdict. Return
 *      `ok: false` only for "could not tell".
 *   3. **The cost is bounded and visible.** The delays are explicit and the last
 *      one repeats rather than growing, and `onRetry` gives the caller something
 *      to print, so a gate cannot quietly acquire a minute of backoff.
 *
 * `run` must NOT throw to signal a transient failure: return `ok: false` with a
 * reason. A throw is a bug rather than a blip, so it propagates instead of being
 * retried three times and reported as an upstream problem.
 */

/** One attempt's outcome: an answer, or a reason it could not be obtained. */
export type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; reason: string; attempts: number };

/**
 * The default backoff: two waits, so three attempts cost at most 7s of extra
 * wall clock on a total failure. Deliberately small. The canary shares its run
 * with the booking scenarios and pays this on every tick, so it passes a shorter
 * list of its own.
 */
export const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000] as const;

export async function retryTransient<T>(opts: {
  /** The work. Called with the 1-based attempt number. */
  run: (attempt: number) => Promise<Attempt<T>>;
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Waits BETWEEN attempts. The last value repeats if there are more gaps. */
  delaysMs?: readonly number[];
  /** Injected so a suite costs no wall clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, so the retry is visible in the log. */
  onRetry?: (info: { attempt: number; reason: string; waitMs: number }) => void;
}): Promise<RetryResult<T>> {
  const max = opts.attempts ?? 3;
  if (!Number.isInteger(max) || max < 1) {
    // Failing here rather than returning a failure: zero attempts would report a
    // hard verdict having measured nothing, which is exactly the shape these
    // gates keep being rewritten to stop doing (L98).
    throw new Error(
      `retryTransient: attempts must be a positive integer, got ${String(opts.attempts)}`,
    );
  }
  const delays = opts.delaysMs?.length ? opts.delaysMs : DEFAULT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastReason = "no attempt was made";
  for (let attempt = 1; attempt <= max; attempt++) {
    const outcome = await opts.run(attempt);
    if (outcome.ok) return { ok: true, value: outcome.value, attempts: attempt };
    lastReason = outcome.reason;
    if (attempt < max) {
      const waitMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
      opts.onRetry?.({ attempt, reason: outcome.reason, waitMs });
      if (waitMs > 0) await sleep(waitMs);
    }
  }
  return {
    ok: false,
    reason: `${lastReason} (failed on all ${max} attempt(s))`,
    attempts: max,
  };
}

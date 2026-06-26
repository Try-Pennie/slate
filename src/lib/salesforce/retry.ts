/**
 * Retry + timeout wrapper for Salesforce HTTP calls (#485). A single transient
 * blip on the path to Salesforce (e.g. a Cloudflare 522 connection-timeout, or a
 * dropped socket) used to fail the entire roster sync; the token fetch and the
 * SOQL queries had no timeout and no retry. These helpers add a per-attempt
 * timeout and a small exponential backoff so a momentary fault clears itself
 * instead of paging anyone.
 *
 * The pure decisions (`sfBackoffMs`, `shouldRetrySf`) are kept IO-free so they're
 * unit-testable; `fetchSfWithRetry` takes injectable `fetchImpl`/`sleep` so the
 * loop can be exercised without real network or timers.
 */

/** Total attempts (initial try + retries) for a Salesforce request. */
export const SF_MAX_ATTEMPTS = 3;
/** Per-attempt request timeout. */
export const SF_TIMEOUT_MS = 10_000;

/** Backoff before the next attempt, given attempts already made (0-based). */
export function sfBackoffMs(attempt: number): number {
  return 500 * Math.pow(2, Math.max(attempt, 0));
}

/**
 * Retry a transient failure: a network/timeout error (`status === null`), a 429,
 * or any 5xx (covers Cloudflare's 520-526). Never retry a 4xx (bad creds/request
 * won't self-heal), and never retry once the final attempt has run.
 */
export function shouldRetrySf(
  status: number | null,
  attempt: number,
  maxAttempts: number,
): boolean {
  if (attempt >= maxAttempts - 1) return false;
  if (status === null) return true;
  if (status === 429) return true;
  return status >= 500;
}

export interface SfFetchOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * fetch() with a per-attempt timeout and transient-failure retries. On a
 * retryable status the FINAL attempt's response is returned (not thrown) so the
 * caller keeps building its existing rich error (status + body); only a network
 * error that survives every attempt is rethrown.
 */
export async function fetchSfWithRetry(
  url: string,
  init: RequestInit,
  opts: SfFetchOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? SF_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? SF_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await doFetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok || !shouldRetrySf(res.status, attempt, maxAttempts)) return res;
      lastErr = new Error(`SF request failed: ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (!shouldRetrySf(null, attempt, maxAttempts)) throw err;
    }
    await sleep(sfBackoffMs(attempt));
  }
  throw lastErr ?? new Error("SF request failed: retries exhausted");
}

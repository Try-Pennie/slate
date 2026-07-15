// Sanity test for the Salesforce fetch retry/timeout helper (#485).
// Run: node --experimental-strip-types scripts/test-salesforce-retry.ts
import {
  SF_MAX_ATTEMPTS,
  sfBackoffMs,
  shouldRetrySf,
  fetchSfWithRetry,
} from "../src/lib/salesforce/retry.ts";
import { assert, finish } from "./lib/harness.ts";

// --- sfBackoffMs: positive and strictly increasing across attempts ---
assert(sfBackoffMs(0) > 0, "first backoff is positive");
assert(sfBackoffMs(1) > sfBackoffMs(0), "backoff grows after a second attempt");
assert(sfBackoffMs(2) > sfBackoffMs(1), "backoff keeps growing");

// --- shouldRetrySf: retry transient (network/5xx/429), give up on 4xx + last try ---
const MAX = 3;
assert(shouldRetrySf(null, 0, MAX), "network/timeout error is retryable");
assert(shouldRetrySf(522, 0, MAX), "522 (CF connection timeout) is retryable");
assert(shouldRetrySf(500, 1, MAX), "500 is retryable");
assert(shouldRetrySf(503, 1, MAX), "503 is retryable");
assert(shouldRetrySf(429, 0, MAX), "429 (rate limited) is retryable");
assert(!shouldRetrySf(400, 0, MAX), "400 is not retryable");
assert(!shouldRetrySf(401, 0, MAX), "401 (bad creds) is not retryable");
assert(!shouldRetrySf(403, 0, MAX), "403 is not retryable");
assert(!shouldRetrySf(404, 0, MAX), "404 is not retryable");
assert(!shouldRetrySf(522, MAX - 1, MAX), "no retry after the last attempt (status)");
assert(!shouldRetrySf(null, MAX - 1, MAX), "no retry after the last attempt (network)");

// --- fetchSfWithRetry: harness with injected fetch + sleep (no real IO/timers) ---
type Step = number | "throw"; // an HTTP status to return, or a network error
function harness(steps: Step[]) {
  const inits: RequestInit[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    inits.push(init);
    const step = steps[i++];
    if (step === "throw") throw new Error("network down");
    return new Response(step === 200 ? "ok" : `error code: ${step}`, {
      status: step as number,
    });
  }) as unknown as typeof fetch;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { fetchImpl, sleep, inits, sleeps };
}

async function run() {
  // Retries past a 522, then succeeds.
  {
    const h = harness([522, 200]);
    const res = await fetchSfWithRetry(
      "https://sf/token",
      { method: "POST" },
      { fetchImpl: h.fetchImpl, sleep: h.sleep, maxAttempts: 3 },
    );
    assert(res.ok && res.status === 200, "recovers after a transient 522");
    assert(h.inits.length === 2, "stops calling fetch once it succeeds");
    assert(h.sleeps.length === 1, "backs off once between the two tries");
  }

  // Retries past a network error, then succeeds.
  {
    const h = harness(["throw", 200]);
    const res = await fetchSfWithRetry(
      "https://sf/token",
      {},
      { fetchImpl: h.fetchImpl, sleep: h.sleep, maxAttempts: 3 },
    );
    assert(res.ok, "recovers after a transient network error");
    assert(h.inits.length === 2, "retried once after the network error");
  }

  // Persistent 522: returns the final response so the caller builds its error.
  {
    const h = harness([522, 522, 522]);
    const res = await fetchSfWithRetry(
      "https://sf/token",
      {},
      { fetchImpl: h.fetchImpl, sleep: h.sleep, maxAttempts: 3 },
    );
    assert(res.status === 522, "returns the last 522 after exhausting retries");
    assert(h.inits.length === 3, "tried exactly maxAttempts times");
    assert(h.sleeps.length === 2, "backed off between each of the 3 tries");
  }

  // Persistent network error: throws after exhausting retries.
  {
    const h = harness(["throw", "throw", "throw"]);
    let threw = false;
    try {
      await fetchSfWithRetry(
        "https://sf/q",
        {},
        { fetchImpl: h.fetchImpl, sleep: h.sleep, maxAttempts: 3 },
      );
    } catch {
      threw = true;
    }
    assert(threw, "throws when every attempt is a network error");
    assert(h.inits.length === 3, "tried exactly maxAttempts times before giving up");
  }

  // 401: no retry, returns immediately.
  {
    const h = harness([401]);
    const res = await fetchSfWithRetry(
      "https://sf/token",
      {},
      { fetchImpl: h.fetchImpl, sleep: h.sleep, maxAttempts: 3 },
    );
    assert(res.status === 401, "returns a 401 without retrying");
    assert(h.inits.length === 1, "does not retry an auth failure");
    assert(h.sleeps.length === 0, "never backs off on a non-retryable status");
  }

  // Each attempt gets a timeout signal and preserves the caller's init.
  {
    const h = harness([200]);
    await fetchSfWithRetry(
      "https://sf/token",
      { method: "POST", headers: { "content-type": "x" } },
      { fetchImpl: h.fetchImpl, sleep: h.sleep, maxAttempts: 3 },
    );
    assert(h.inits[0].signal instanceof AbortSignal, "attaches a timeout signal");
    assert(h.inits[0].method === "POST", "preserves the caller's method");
    assert(
      (h.inits[0].headers as Record<string, string>)["content-type"] === "x",
      "preserves the caller's headers",
    );
  }

  assert(SF_MAX_ATTEMPTS >= 2, "default allows at least one retry");
}

await run();
finish();

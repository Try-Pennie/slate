// Sanity test for the Salesforce fetch retry/timeout helper (#485).
// Run: node --experimental-strip-types scripts/test-salesforce-retry.ts
import {
  SF_MAX_ATTEMPTS,
  sfBackoffMs,
  shouldRetrySf,
  fetchSfWithRetry,
} from "../src/lib/salesforce/retry.ts";
import { withinCallBudget } from "../src/lib/call-budget.ts";
import { DeadlineExceededError } from "../src/lib/fetch-within-deadline.ts";
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

  // #3102: on the confirm path a lead's routing code can be read from Salesforce,
  // and three attempts of 10 seconds each would hold the lead past the booker's
  // abort on their own. Inside a call budget that is already spent, no attempt
  // starts and nothing is retried: the deadline surfaces at once.
  {
    const h = harness([200]);
    let caught: unknown = null;
    await withinCallBudget(0, "the booking confirm", () =>
      fetchSfWithRetry("https://sf/q", {}, { fetchImpl: h.fetchImpl, sleep: h.sleep }),
    ).catch((e: unknown) => {
      caught = e;
    });
    assert(caught instanceof DeadlineExceededError, "a spent call budget refuses a Salesforce attempt");
    assert(h.inits.length === 0, "and sends nothing");
    assert(h.sleeps.length === 0, "and does not back off to retry a budget that cannot come back");
  }

  // An attempt the BUDGET cut short ends in the platform's TimeoutError, which says
  // nothing about the budget. It must surface as the deadline (named for
  // Salesforce, carrying the budget), so the confirm path answers its retryable
  // 503 and pages, and it must not be retried: the time it ran out of is gone.
  // The fetch throws the abort's own error at once, so nothing waits for real.
  {
    const inits: RequestInit[] = [];
    const sleeps: number[] = [];
    let caught: unknown = null;
    await withinCallBudget(1_000, "the booking confirm", () =>
      fetchSfWithRetry(
        "https://sf/q",
        {},
        {
          fetchImpl: (async (_u: string, init: RequestInit) => {
            inits.push(init);
            throw new DOMException("The operation timed out.", "TimeoutError");
          }) as unknown as typeof fetch,
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
        },
      ),
    ).catch((e: unknown) => {
      caught = e;
    });
    assert(caught instanceof DeadlineExceededError, "a budget-shortened Salesforce timeout surfaces as the deadline");
    assert((caught as DeadlineExceededError).label === "salesforce", "named for Salesforce");
    assert((caught as DeadlineExceededError).budget?.label === "the booking confirm", "and carrying the budget that cut it short");
    assert(inits.length === 1, "and is not retried");
    assert(sleeps.length === 0, "with no backoff spent on it");
  }

  // A timeout on Salesforce's OWN limit, with no budget involved, is the
  // transient failure it always was, and is still retried.
  {
    let calls = 0;
    const sleeps: number[] = [];
    let caught: unknown = null;
    await fetchSfWithRetry(
      "https://sf/q",
      {},
      {
        fetchImpl: (async () => {
          calls++;
          throw new DOMException("The operation timed out.", "TimeoutError");
        }) as unknown as typeof fetch,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      },
    ).catch((e: unknown) => {
      caught = e;
    });
    assert(calls === SF_MAX_ATTEMPTS, "outside a budget a Salesforce timeout is retried as before");
    assert(!(caught instanceof DeadlineExceededError), "and is not relabelled as a budget deadline");
  }

  // With budget to spare it behaves exactly as before.
  {
    const h = harness([503, 200]);
    const res = await withinCallBudget(60_000, "the booking confirm", () =>
      fetchSfWithRetry("https://sf/q", {}, { fetchImpl: h.fetchImpl, sleep: h.sleep }),
    );
    assert(res.status === 200, "inside a roomy budget a transient failure is still retried");
  }

  assert(SF_MAX_ATTEMPTS >= 2, "default allows at least one retry");
}

await run();
finish();

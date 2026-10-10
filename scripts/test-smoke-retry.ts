// #3583: withRetry retries a THROWN attempt a bounded number of times, returns a
// completed result without retrying, gives up (rethrows) after the max, and by default
// retries ONLY a transient network error (L35), not a deterministic bug. Pure, with an
// injected no-op sleep so there is no real delay.
//
// Run: node --experimental-strip-types scripts/test-smoke-retry.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { withRetry, isTransientNetworkError } from "./smoke-lib.ts";

const noSleep = async () => {};
const anyError = { retryable: () => true, sleep: noSleep };
// A real undici network failure: `TypeError: fetch failed` with a coded cause.
const netErr = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
// A real undici invalid-URL failure: it ALSO carries a cause, coded ERR_INVALID_URL
// (this is the 2026-08-14 outage shape, #1495), and must NOT be retried.
const urlErr = () => Object.assign(new TypeError("Failed to parse URL from /x"), { cause: Object.assign(new Error("Invalid URL"), { code: "ERR_INVALID_URL" }) });

// A deterministic bad-argument error that still carries a cause+code (not in the
// transient allowlist): it must NOT be retried.
const argErr = () => Object.assign(new TypeError("invalid argument"), { cause: Object.assign(new Error("bad arg"), { code: "UND_ERR_INVALID_ARG" }) });

// --- the classifier: an ALLOWLIST of transient codes, not a denylist ---
assert(isTransientNetworkError(netErr()), "a network code (ECONNRESET) is transient");
assert(!isTransientNetworkError(urlErr()), "an invalid-URL TypeError (ERR_INVALID_URL) is NOT transient");
assert(!isTransientNetworkError(argErr()), "another coded deterministic error (UND_ERR_INVALID_ARG) is NOT transient");
assert(!isTransientNetworkError(new TypeError("Failed to parse URL")), "a TypeError with no cause is not transient");
assert(!isTransientNetworkError(new Error("boom")), "a plain Error is not transient");

// --- retry mechanics (retryable forced on) ---
let calls = 0;
const ok = await withRetry(async () => { calls++; return "ok"; }, anyError);
eq(ok, "ok", "returns the attempt's result");
eq(calls, 1, "a success is called exactly once");

calls = 0;
const recovered = await withRetry(
  async () => { calls++; if (calls < 2) throw new Error("x"); return "second"; },
  anyError,
);
eq(recovered, "second", "recovers on the retry");
eq(calls, 2, "retried once before succeeding");

// The failure path: always throws, gives up after `attempts`, rethrows the last error.
calls = 0;
let threw = false;
try {
  await withRetry(async () => { calls++; throw new Error("down"); }, { attempts: 3, ...anyError });
} catch (e) { threw = true; eq((e as Error).message, "down", "rethrows the last error"); }
assert(threw, "throws after exhausting attempts");
eq(calls, 3, "tried exactly `attempts` times");

// --- the DEFAULT predicate decides what is retried ---
calls = 0;
const net = await withRetry(async () => { calls++; if (calls < 2) throw netErr(); return "net-ok"; }, { sleep: noSleep });
eq(net, "net-ok", "a transient network error is retried by default");
eq(calls, 2, "retried the network error once");

calls = 0;
threw = false;
try {
  await withRetry(async () => { calls++; throw urlErr(); }, { attempts: 5, sleep: noSleep });
} catch { threw = true; }
assert(threw, "a deterministic invalid-URL error throws");
eq(calls, 1, "a deterministic invalid-URL error is NOT retried by default");

finish();

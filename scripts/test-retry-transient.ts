// The shared bounded retry (#1437, #1210).
//
// Two gates were failing for reasons unrelated to the thing they check: the
// migration drift gate on a Supabase 502, the static asset probe on a single
// unreachable fetch. A gate that red flags healthy changes gets re-run
// reflexively, which is how a REAL failure ends up being re-run too (L36).
//
// The whole risk of adding a retry is that it turns "could not check" into a
// pass. So the properties pinned here are mostly about what retrying must NOT
// do: it must never invent a success, it must run exactly as many times as it
// says, it must not retry something that already answered, and its delays must
// stay bounded so a gate cannot quietly grow a minute of backoff.
//
// Run: node --experimental-strip-types scripts/test-retry-transient.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { DEFAULT_RETRY_DELAYS_MS, retryTransient } from "./lib/retry.ts";

/** A sleep that records instead of waiting, so the suite costs no wall clock. */
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

// --- a first attempt that answers is not retried --------------------------
{
  const { waits, sleep } = fakeSleep();
  let calls = 0;
  const r = await retryTransient<string>({
    run: async () => {
      calls++;
      return { ok: true, value: "answered" };
    },
    sleep,
  });
  assert(r.ok, "a first attempt that succeeds returns ok");
  eq(r.ok ? r.value : null, "answered", "the value comes straight through");
  eq(calls, 1, "a success is attempted exactly once");
  eq(waits.length, 0, "no delay is paid when nothing had to be retried");
}

// --- a transient failure clears on the retry ------------------------------
{
  const { waits, sleep } = fakeSleep();
  let calls = 0;
  const r = await retryTransient<string>({
    run: async () => {
      calls++;
      return calls === 1 ? { ok: false, reason: "502 from upstream" } : { ok: true, value: "second" };
    },
    sleep,
  });
  assert(r.ok, "#1437: a single upstream blip does not fail the caller");
  eq(r.attempts, 2, "the attempt count reports that it took two goes");
  eq(calls, 2, "the work really ran twice");
  eq(waits.length, 1, "exactly one delay was paid, between the two attempts");
}

// --- exhausting the attempts stays a failure, and says so -----------------
// The one that matters. A retry that ran out of attempts must never come back
// ok, and the reason must carry BOTH the last failure and the fact that every
// attempt was used, or a reader cannot tell a one-off from a dead upstream.
{
  const { waits, sleep } = fakeSleep();
  let calls = 0;
  const r = await retryTransient<string>({
    run: async () => {
      calls++;
      return { ok: false, reason: `attempt ${calls} said 502` };
    },
    sleep,
  });
  assert(!r.ok, "exhausting every attempt fails, it never invents a success");
  eq(calls, 3, "the default is three attempts");
  eq(r.attempts, 3, "the reported attempt count matches what really ran");
  const reason = r.ok ? "" : r.reason;
  assert(reason.includes("attempt 3 said 502"), "the reason carries the last failure");
  assert(/3 attempt/.test(reason), "the reason says every attempt was used up");
  eq(waits.length, 2, "a delay is paid between attempts, never after the last one");
}

// --- the caller decides what counts as retryable --------------------------
// #1210: a reachable 404 must fail on the first look, because a retry there
// only delays the same answer. The helper never inspects the value, so the
// caller keeps that call by returning ok for "answered, badly".
{
  const { waits, sleep } = fakeSleep();
  let calls = 0;
  const r = await retryTransient<number>({
    run: async () => {
      calls++;
      return { ok: true, value: 404 };
    },
    sleep,
  });
  assert(r.ok, "an answer the caller dislikes is still an answer");
  eq(calls, 1, "#1210: something that already answered is not retried");
  eq(waits.length, 0, "and costs no delay");
}

// --- attempts: 1 means no retry at all -----------------------------------
{
  const { waits, sleep } = fakeSleep();
  let calls = 0;
  const r = await retryTransient<string>({
    attempts: 1,
    run: async () => {
      calls++;
      return { ok: false, reason: "no" };
    },
    sleep,
  });
  assert(!r.ok, "one attempt that fails fails");
  eq(calls, 1, "attempts: 1 runs the work once");
  eq(waits.length, 0, "and never sleeps");
}

// --- zero attempts is a bug, not a silent failure ------------------------
// A wait with no attempts would return a failure having run NOTHING, which is
// the parse-nothing-and-pass shape wearing the other hat (L98): the caller
// would report a hard failure it never measured.
{
  let threw = false;
  try {
    await retryTransient<string>({ attempts: 0, run: async () => ({ ok: true, value: "x" }) });
  } catch {
    threw = true;
  }
  assert(threw, "attempts: 0 throws rather than failing having run nothing");
}

// --- the delays are the configured ones, and they are bounded ------------
// A gate that grew a 60s backoff would still be green, so nothing else would
// notice. Pinning the values keeps the cost of a retry visible in review.
{
  const { waits, sleep } = fakeSleep();
  await retryTransient<string>({
    attempts: 3,
    delaysMs: [10, 20],
    run: async () => ({ ok: false, reason: "no" }),
    sleep,
  });
  eq(waits, [10, 20], "the configured delays are used in order");
}
{
  const { waits, sleep } = fakeSleep();
  await retryTransient<string>({
    attempts: 4,
    delaysMs: [10],
    run: async () => ({ ok: false, reason: "no" }),
    sleep,
  });
  eq(waits, [10, 10, 10], "a short delay list repeats its last value rather than running unbounded");
}
{
  const total = DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  assert(total <= 10_000, `the default backoff totals ${total}ms, which stays cheap enough for a CI step`);
}

// --- the caller can log each retry ---------------------------------------
// A retry nobody can see is a gate that looks fast one day and slow the next
// with no explanation in the log.
{
  const { sleep } = fakeSleep();
  const seen: string[] = [];
  await retryTransient<string>({
    attempts: 2,
    delaysMs: [5],
    run: async () => ({ ok: false, reason: "502" }),
    sleep,
    onRetry: (info) => seen.push(`${info.attempt}:${info.reason}:${info.waitMs}`),
  });
  eq(seen, ["1:502:5"], "onRetry fires once per retry, with the attempt, reason and wait");
}

finish();

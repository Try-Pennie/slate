/**
 * #3102: the deadline every Supabase client, default Google call and token mint
 * now goes through. No test here waits on real time: the timer is injected and
 * fired by hand, and the "hung dependency" is a fetch that never settles at all,
 * not even when its signal aborts, which is the worst case the race must survive.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-fetch-within-deadline.ts
 */
import { createClient } from "@supabase/supabase-js";
import {
  DeadlineExceededError,
  NO_DEADLINE,
  fetchWithDeadline,
  fetchWithinDeadline,
  isDeadlineExceeded,
  type FetchLike,
} from "../src/lib/fetch-within-deadline.ts";
import type { ScheduleTimer } from "../src/lib/read-within-deadline.ts";
import { unwrap } from "../src/lib/db/result.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A timer that only fires when the test says so, and counts its cancellations. */
function manualTimer() {
  const armed: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  let cancels = 0;
  const schedule: ScheduleTimer = (ms, fire) => {
    const t = { ms, fire, cancelled: false };
    armed.push(t);
    return () => {
      t.cancelled = true;
      cancels++;
    };
  };
  return {
    schedule,
    armed,
    cancels: () => cancels,
    expire: () => {
      for (const t of armed) if (!t.cancelled) t.fire();
    },
  };
}

/** A dependency that accepted the request and will never answer, signal or not. */
function hungFetch() {
  const seen: (AbortSignal | undefined)[] = [];
  const impl: FetchLike = (_input, init) => {
    seen.push(init?.signal ?? undefined);
    return new Promise<Response>(() => {});
  };
  return { impl, seen };
}

const tick = () => new Promise((r) => setImmediate(r));

// A hung call rejects with the named error once its deadline passes, and the
// request it sent is aborted so the platform stops waiting on the socket.
{
  const timer = manualTimer();
  const hung = hungFetch();
  let caught: unknown = null;
  const p = fetchWithinDeadline(hung.impl, "https://x.test/a", {}, 8000, "google events.insert", timer.schedule).catch(
    (e: unknown) => {
      caught = e;
    },
  );
  await tick();
  eq(timer.armed.length, 1, "one timer is armed per call");
  eq(timer.armed[0].ms, 8000, "the timer is armed for the deadline it was given");
  assert(caught === null, "nothing is decided before the deadline passes");
  timer.expire();
  await p;
  assert(caught instanceof DeadlineExceededError, "a hung call rejects with DeadlineExceededError");
  const err = caught as DeadlineExceededError;
  eq(err.label, "google events.insert", "the error names what timed out");
  eq(err.timeoutMs, 8000, "the error carries the deadline it missed");
  eq(err.message, "google events.insert did not answer within 8000ms", "the message says which call and how long");
  assert(hung.seen[0]?.aborted === true, "the hung request's signal is aborted on expiry");
  eq(timer.cancels(), 1, "the timer is cleared once the race settles, even on expiry");
}

// A fetch that DOES honour its signal rejects on the abort with a bare AbortError.
// The deadline's own error must still be what the caller gets, or a timeout reads
// as an anonymous abort that names no call and no deadline.
{
  const timer = manualTimer();
  let caught: unknown = null;
  const p = fetchWithinDeadline(
    (_i, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      }),
    "https://x.test/a2",
    {},
    500,
    "google freeBusy",
    timer.schedule,
  ).catch((e: unknown) => {
    caught = e;
  });
  await tick();
  timer.expire();
  await p;
  assert(caught instanceof DeadlineExceededError, "a signal-honouring fetch still surfaces the deadline error, not a bare abort");
}

// An answer in time is returned untouched and its timer cleared, so a fast call
// never leaves a live timer behind (one per Supabase request adds up).
{
  const timer = manualTimer();
  const res = await fetchWithinDeadline(
    async () => new Response("ok", { status: 201 }),
    "https://x.test/b",
    undefined,
    8000,
    "supabase",
    timer.schedule,
  );
  eq(res.status, 201, "a response that arrives in time is returned as it is");
  eq(timer.cancels(), 1, "the timer is cleared when the response wins the race");
  assert(timer.armed[0].cancelled, "the timer was cancelled before anything could fire it");
}

// A call that FAILS in time keeps its own error, so a refusal is never relabelled
// as a timeout (L11), and the timer is still cleared.
{
  const timer = manualTimer();
  const boom = new Error("connection refused");
  let caught: unknown = null;
  await fetchWithinDeadline(
    async () => {
      throw boom;
    },
    "https://x.test/c",
    {},
    8000,
    "supabase",
    timer.schedule,
  ).catch((e: unknown) => {
    caught = e;
  });
  assert(caught === boom, "a failure inside the deadline surfaces as itself");
  assert(!isDeadlineExceeded(caught), "and is not read as a timeout");
  eq(timer.cancels(), 1, "the timer is cleared when the call fails first");
}

// The caller's own signal still aborts the request: the wrapper replaces the
// signal it hands the fetch, so it has to carry the caller's abort across.
{
  const timer = manualTimer();
  const hung = hungFetch();
  const caller = new AbortController();
  const p = fetchWithinDeadline(hung.impl, "https://x.test/d", { signal: caller.signal }, 8000, "x", timer.schedule);
  p.catch(() => {});
  await tick();
  assert(hung.seen[0]?.aborted === false, "the request starts un-aborted");
  caller.abort();
  assert(hung.seen[0]?.aborted === true, "aborting the caller's signal aborts the request");
  timer.expire();
  await p.catch(() => {});
}

// Opting out is by name only, and an opted-out call arms nothing.
{
  const timer = manualTimer();
  let passedInit: RequestInit | undefined;
  const init = { method: "POST" };
  await fetchWithinDeadline(
    async (_i, given) => {
      passedInit = given;
      return new Response(null, { status: 204 });
    },
    "https://x.test/e",
    init,
    NO_DEADLINE,
    "x",
    timer.schedule,
  );
  eq(timer.armed.length, 0, "NO_DEADLINE arms no timer");
  assert(passedInit === init, "NO_DEADLINE passes the request through unchanged");
}

// Recognised wherever it lands: thrown directly, as a cause, and folded into a
// PostgREST error message that `unwrap` then quotes.
{
  const direct = new DeadlineExceededError("supabase", 15000);
  assert(isDeadlineExceeded(direct), "the error itself is recognised");
  assert(isDeadlineExceeded(new Error("wrapped", { cause: direct })), "a wrapped cause is recognised");
  assert(
    isDeadlineExceeded(new Error("read failed [pool]: DeadlineExceededError: supabase did not answer within 15000ms")),
    "the unwrap shape of a PostgREST timeout is recognised",
  );
  assert(!isDeadlineExceeded(new DOMException("The operation was aborted.", "AbortError")), "a plain abort is not a deadline");
  assert(!isDeadlineExceeded(new Error("did not answer within 5 minutes")), "prose about time is not a deadline");
  assert(!isDeadlineExceeded(null), "null is not a deadline");
}

// The Supabase end to end, through the real supabase-js client. A hung GET must come
// back as ONE failed attempt with the deadline in its message. PostgREST retries a
// GET's network failure three times with real 1, 2 and 4 second sleeps, and skips
// that only for an abort, so this is what proves the ABORT_ERR code is doing its
// job: without it the fetch below is called four times. The timer here expires
// on the next turn of the loop, every time it is armed, so a retry cannot strand
// the test waiting on a deadline nobody fires; it finishes and fails on the count.
{
  const expiresAtOnce: ScheduleTimer = (_ms, fire) => {
    const h = setImmediate(fire);
    return () => clearImmediate(h);
  };
  const hung = hungFetch();
  const client = createClient("https://x.test", "sb_secret_test", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithDeadline(hung.impl, 15000, "supabase", expiresAtOnce) },
  });
  const res = await client.from("buckets").select("id");
  eq(hung.seen.length, 1, "a hung PostgREST GET is attempted once, never retried");
  assert(res.error !== null, "the hung read comes back as an error, not as data");
  assert(res.data === null, "and carries no data a caller could read as an empty table");
  let thrown: unknown = null;
  try {
    unwrap(res, "buckets");
  } catch (e) {
    thrown = e;
  }
  assert(isDeadlineExceeded(thrown), "unwrap's error is still recognisable as a deadline");
}

finish();

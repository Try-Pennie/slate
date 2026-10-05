// #3258: the slot refresh a booking schedules is coalesced per POOL.
//
// The three arm load run (2026-10-04) measured the per booking recompute as the
// code half of the confirm slowdown: about three seconds of reads and compute per
// booking, sixty a minute, crowding the Worker that answers the next confirms (p99
// CPU 2.4s against 0.6s with it off). Most of those computes were repeats: sixty
// codes are fifteen pools, and a hot pool takes a booking every few seconds.
//
// The rule pinned here, from both sides (L1, L159):
//   1. NOTHING IS DROPPED: every request is covered by a refresh that STARTS after
//      it, so a booked time always leaves the offered list. A debounce that skips a
//      request inside its window would lose exactly the booking that arrived during
//      the previous compute.
//   2. A QUIET pool refreshes at once (the leading edge), so the common case is as
//      fresh as before.
//   3. A BUSY pool computes at most once per window: requests inside it join one
//      trailing refresh rather than each starting their own.
//   4. Pools never coalesce with each other, and a failed refresh reaches every
//      requester it was covering, then the next request starts afresh.
//
// Run: node --experimental-strip-types scripts/test-pool-refresh-coalescer.ts
import { makePoolRefreshCoalescer, POST_CONFIRM_REFRESH_WINDOW_MS } from "../src/lib/availability/pool-refresh-coalescer.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A fake clock whose sleeps resolve when the test advances time past them. */
function clock() {
  let t = 1_000_000;
  const sleepers: { at: number; resolve: () => void }[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((resolve) => sleepers.push({ at: t + ms, resolve })),
    async advance(ms: number) {
      t += ms;
      for (const s of sleepers.filter((x) => x.at <= t)) {
        sleepers.splice(sleepers.indexOf(s), 1);
        s.resolve();
      }
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

/** A refresh whose completion the test controls, recording when each one started. */
function refreshes(c: ReturnType<typeof clock>) {
  const starts: { key: string; at: number; codes: string[]; finish: (err?: Error) => void }[] = [];
  const run = (key: string) => (codes: string[]) =>
    new Promise<void>((resolve, reject) => {
      starts.push({ key, at: c.now(), codes: [...codes].sort(), finish: (err) => (err ? reject(err) : resolve()) });
    });
  return { starts, run };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

assert(POST_CONFIRM_REFRESH_WINDOW_MS >= 5_000, "the window is long enough to collapse a busy pool's bookings");
assert(
  POST_CONFIRM_REFRESH_WINDOW_MS <= 15_000,
  "and short enough that a wait plus a compute fits inside the platform's thirty second cut on deferred work",
);

// --- a quiet pool refreshes at once ------------------------------------------------
{
  const c = clock();
  const r = refreshes(c);
  const co = makePoolRefreshCoalescer({ now: c.now, sleep: c.sleep, windowMs: 10_000, lastStartedAt: new Map() });
  const done = co.request("pool-a", "pool-a-code", r.run("pool-a"));
  await flush();
  eq(r.starts.length, 1, "the first request starts a refresh immediately");
  eq(r.starts[0]!.at, c.now(), "with no wait");
  r.starts[0]!.finish();
  await done;
}

// --- a busy pool computes once per window, and drops nothing ---------------------------
{
  const c = clock();
  const r = refreshes(c);
  const lastStartedAt = new Map<string, number>();
  const co = makePoolRefreshCoalescer({ now: c.now, sleep: c.sleep, windowMs: 10_000, lastStartedAt });
  const first = co.request("pool-a", "pool-a-code", r.run("pool-a"));
  await flush();
  const t0 = c.now();
  eq(lastStartedAt.get("pool-a"), t0, "the shared map records when the pool's refresh started");
  // Three more bookings land while the first compute runs and inside the window.
  await c.advance(1_000);
  const b = co.request("pool-a", "pool-a-code", r.run("pool-a"));
  await c.advance(1_000);
  const cReq = co.request("pool-a", "pool-a-code", r.run("pool-a"));
  await c.advance(1_000);
  const d = co.request("pool-a", "pool-a-code", r.run("pool-a"));
  await flush();
  eq(r.starts.length, 1, "requests inside the window start nothing of their own");
  r.starts[0]!.finish();
  await first;
  await c.advance(6_999);
  eq(r.starts.length, 1, "the trailing refresh waits out the window");
  await c.advance(1);
  eq(r.starts.length, 2, "then ONE refresh starts for all three");
  assert(r.starts[1]!.at >= t0 + 3_000, "and it starts after the last request it covers, so none is dropped");
  r.starts[1]!.finish();
  await Promise.all([b, cReq, d]);
  eq(r.starts.length, 2, "two computes for four bookings");
}

// --- a request during the trailing run is covered by a later one ------------------------
{
  const c = clock();
  const r = refreshes(c);
  const co = makePoolRefreshCoalescer({ now: c.now, sleep: c.sleep, windowMs: 10_000, lastStartedAt: new Map() });
  void co.request("pool-a", "pool-a-code", r.run("pool-a"));
  await flush();
  await c.advance(500);
  void co.request("pool-a", "pool-a-code", r.run("pool-a")); // trailing
  r.starts[0]!.finish();
  await c.advance(9_500);
  eq(r.starts.length, 2, "the trailing refresh started");
  await c.advance(200);
  const late = co.request("pool-a", "pool-a-code", r.run("pool-a")); // lands while the trailing one RUNS
  await flush();
  eq(r.starts.length, 2, "a request during a running refresh does not join it, since that one began before it");
  r.starts[1]!.finish();
  await c.advance(10_000);
  eq(r.starts.length, 3, "it gets a refresh of its own, after the window");
  r.starts[2]!.finish();
  await late;
}

// --- a refresh still running when the window ends is waited for ---------------------------
{
  const c = clock();
  const r = refreshes(c);
  const co = makePoolRefreshCoalescer({ now: c.now, sleep: c.sleep, windowMs: 10_000, lastStartedAt: new Map() });
  void co.request("pool-a", "pool-a-code", r.run("pool-a"));
  await flush();
  await c.advance(1_000);
  void co.request("pool-a", "pool-a-code", r.run("pool-a"));
  await c.advance(12_000);
  eq(r.starts.length, 1, "no second compute of one pool runs beside the first");
  r.starts[0]!.finish();
  await flush();
  eq(r.starts.length, 2, "it starts as soon as the first finishes");
}

// --- pools are independent ------------------------------------------------------------------
{
  const c = clock();
  const r = refreshes(c);
  const co = makePoolRefreshCoalescer({ now: c.now, sleep: c.sleep, windowMs: 10_000, lastStartedAt: new Map() });
  void co.request("pool-a", "pool-a-code", r.run("pool-a"));
  void co.request("pool-b", "pool-b-code", r.run("pool-b"));
  await flush();
  eq(r.starts.map((s) => s.key), ["pool-a", "pool-b"], "a booking in another pool is never held for this one");
  r.starts.forEach((s) => s.finish());
}

// --- a failure reaches its requesters, and does not wedge the pool ---------------------------
{
  const c = clock();
  const r = refreshes(c);
  const co = makePoolRefreshCoalescer({ now: c.now, sleep: c.sleep, windowMs: 10_000, lastStartedAt: new Map() });
  void co.request("pool-a", "pool-a-code", r.run("pool-a")).catch(() => {});
  await flush();
  await c.advance(1_000);
  const joined = co.request("pool-a", "pool-a-code", r.run("pool-a"));
  const joinedToo = co.request("pool-a", "pool-a-code", r.run("pool-a"));
  r.starts[0]!.finish();
  await c.advance(9_000);
  r.starts[1]!.finish(new Error("bucket_slots write refused"));
  const outcomes = await Promise.allSettled([joined, joinedToo]);
  eq(
    outcomes.map((o) => o.status),
    ["rejected", "rejected"],
    "a failed trailing refresh rejects for every request it covered, so each is logged",
  );
  await c.advance(10_000);
  const after = co.request("pool-a", "pool-a-code", r.run("pool-a"));
  await flush();
  eq(r.starts.length, 3, "and the next request starts a fresh refresh");
  r.starts[2]!.finish();
  await after;
}

// --- a pushed refresh moments ago counts against the window ----------------------------------
{
  const c = clock();
  const r = refreshes(c);
  const lastStartedAt = new Map<string, number>([["pool-a", c.now() - 2_000]]);
  const co = makePoolRefreshCoalescer({ now: c.now, sleep: c.sleep, windowMs: 10_000, lastStartedAt });
  void co.request("pool-a", "pool-a-code", r.run("pool-a"));
  await flush();
  eq(r.starts.length, 0, "a pool the push path refreshed two seconds ago waits out the rest of the window");
  await c.advance(8_000);
  eq(r.starts.length, 1, "then refreshes, AFTER the request, so the booking is included");
}

// --- #3293 review: the trailing refresh covers EVERY joiner's code -------------------------
// The refresh is resolved from the codes it covers when it runs, never from the first
// requester's alone: a bucket can change pools inside the window, and a joiner whose
// code is still in the pool must still get it refreshed.
{
  const c = clock();
  const r = refreshes(c);
  const co = makePoolRefreshCoalescer({ now: c.now, sleep: c.sleep, windowMs: 10_000, lastStartedAt: new Map() });
  void co.request("pool-a", "211", r.run("pool-a"));
  await flush();
  eq(r.starts[0]!.codes, ["211"], "a leading refresh is handed the one code that asked");
  await c.advance(1_000);
  void co.request("pool-a", "212", r.run("pool-a"));
  void co.request("pool-a", "222", r.run("pool-a"));
  void co.request("pool-a", "212", r.run("pool-a"));
  r.starts[0]!.finish();
  await c.advance(9_000);
  eq(r.starts.length, 2, "one trailing refresh");
  eq(r.starts[1]!.codes, ["212", "222"], "handed every joiner's code, once each");
  r.starts[1]!.finish();
}

// --- #3293 review: idle keys are evicted --------------------------------------------------
// A key whose refresh finished and whose window has passed holds nothing anyone can
// join or be debounced by, so it is dropped: fallback keys for unknown codes would
// otherwise accumulate for the isolate's life.
{
  const c = clock();
  const r = refreshes(c);
  const lastStartedAt = new Map<string, number>();
  const co = makePoolRefreshCoalescer({ now: c.now, sleep: c.sleep, windowMs: 10_000, lastStartedAt });
  void co.request("code:999", "999", r.run("code:999"));
  await flush();
  r.starts[0]!.finish();
  await flush();
  eq(co.trackedKeys(), 1, "a key just refreshed is still held, for its window");
  await c.advance(10_001);
  void co.request("pool-a", "112", r.run("pool-a"));
  await flush();
  eq(co.trackedKeys(), 1, "after its window, an idle key is evicted when the next request arrives");
  assert(!lastStartedAt.has("code:999"), "and so is its start time");
  assert(lastStartedAt.has("pool-a"), "while the key being refreshed is kept");
  r.starts[1]!.finish();
  // A key with a pending or running refresh is never evicted.
  await c.advance(500);
  void co.request("pool-a", "111", r.run("pool-a"));
  await c.advance(10_000);
  void co.request("pool-b", "211", r.run("pool-b"));
  await flush();
  assert(co.trackedKeys() >= 2, "a key with work in hand is kept");
  r.starts.forEach((x) => x.finish());
}

finish();

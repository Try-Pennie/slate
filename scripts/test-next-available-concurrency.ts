/**
 * #2799: the next available days walk computes its windows concurrently, and the
 * booker waits long enough for the slowest walk to finish.
 *
 * Measured on 2026-09-25 (#1365): a Low bucket (79 staffed agents) costs about
 * 2.5s per 7 day window in production, so a walk that finds nothing and visits all
 * eight windows came to about 20s, which is exactly where the booker used to give
 * up (`REQUEST_TIMEOUT_MS`). The lead the button exists for, somebody arriving
 * during a long closure, was the one most likely to see a timeout instead of a date.
 *
 * What is pinned here, and why each one matters:
 *
 *  - **Order.** Concurrency must not change the answer. When a later window
 *    finishes first, the EARLIEST window with slots still wins, because the lead is
 *    being offered the first days we are open again, not whichever came back first.
 *  - **Failure is not emptiness.** A window that throws must surface as an error.
 *    Folding it in as "no slots" would tell a lead we have no times when we could
 *    not look, which is the one answer this path must never invent.
 *  - **The cap.** No more than `NEXT_WINDOW_CONCURRENCY` windows are ever in
 *    flight, counted with a fake rather than trusted from the code.
 *  - **The budget.** A full eight window walk at the Low depth, on a fake clock,
 *    fits inside the booker's timeout with margin. Asserted against the REAL
 *    constants, so moving either one breaks this.
 *
 * No real time passes anywhere in this file: every wait is on a fake clock.
 *
 * Run: node --experimental-strip-types scripts/test-next-available-concurrency.ts
 */
import {
  probeWindows,
  findNextAvailableSlots,
  NEXT_WINDOW_CONCURRENCY,
  NEXT_WINDOW_COST_MS,
  NEXT_WALK_WORST_CASE_MS,
  NEXT_DAYS_TIMEOUT_MS,
  MAX_LOOKAHEAD_DAYS,
  PROBE_WINDOW_DAYS,
  type Probe,
} from "../src/lib/availability/next-available.ts";
import { REQUEST_TIMEOUT_MS } from "../src/lib/http.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
const probes = probeWindows({ searchedThroughDay: "2026-08-16", zone: ZONE });
const WINDOWS = Math.ceil(MAX_LOOKAHEAD_DAYS / PROBE_WINDOW_DAYS);

/** A promise resolved or rejected from outside, so the test decides the order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

/** A compute whose every window is a deferred the test settles by index. */
function controlled() {
  const pending = new Map<number, ReturnType<typeof deferred<string[]>>>();
  const started: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    started,
    pending,
    get maxInFlight() {
      return maxInFlight;
    },
    compute: (probe: Probe) => {
      const i = probes.indexOf(probe);
      started.push(i);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const d = deferred<string[]>();
      pending.set(i, d);
      return d.promise.finally(() => {
        inFlight--;
      });
    },
  };
}

/** A slot at 13:00Z on the given day of the probe's window. */
function slotIn(i: number, dayOffset = 0): string {
  const from = new Date(Date.parse(probes[i].fromIso));
  from.setUTCDate(from.getUTCDate() + dayOffset);
  from.setUTCHours(13, 0, 0, 0);
  return from.toISOString();
}

// ------------------------------------------------------------ the constants

{
  eq(probes.length, WINDOWS, "the walk has one window per week of lookahead");
  assert(NEXT_WINDOW_CONCURRENCY >= 2, "the walk runs more than one window at a time");
  // The client timeout is derived from the server's worst case, never a bare
  // number beside it: every window, at the measured Low depth cost.
  eq(
    NEXT_WALK_WORST_CASE_MS,
    WINDOWS * NEXT_WINDOW_COST_MS,
    "the worst case is every window at the measured per window cost",
  );
  assert(
    NEXT_DAYS_TIMEOUT_MS > REQUEST_TIMEOUT_MS,
    "this one request waits longer than the shared booker ceiling",
  );
  // Margin: even with NO overlap at all (a compute bound walk on one isolate, the
  // pessimistic reading of where the time goes), the timeout clears the worst case
  // by at least a quarter.
  assert(
    NEXT_WALK_WORST_CASE_MS * 1.25 <= NEXT_DAYS_TIMEOUT_MS,
    `the serial worst case (${NEXT_WALK_WORST_CASE_MS}ms) sits well inside the timeout (${NEXT_DAYS_TIMEOUT_MS}ms)`,
  );
}

// ------------------------------------------------------------ order

{
  // Window 1 comes back FIRST with slots; window 0 comes back later with its own.
  // The answer is window 0's days, because they are earlier.
  const c = controlled();
  const walk = findNextAvailableSlots({ probes, wantDays: 1, zone: ZONE, compute: c.compute });
  await settle();
  assert(c.started.includes(0) && c.started.includes(1), "the first two windows start together");
  c.pending.get(1)!.resolve([slotIn(1)]);
  await settle();
  c.pending.get(0)!.resolve([slotIn(0)]);
  const found = await walk;
  eq(found, [slotIn(0)], "the earliest window with slots wins even when a later one finished first");
}

{
  // Window 0 is empty and window 1 is still running when window 2 answers. The walk
  // must wait for window 1, because its days are earlier than window 2's.
  const c = controlled();
  const walk = findNextAvailableSlots({ probes, wantDays: 1, zone: ZONE, compute: c.compute });
  await settle();
  c.pending.get(0)!.resolve([]);
  await settle();
  c.pending.get(2)!.resolve([slotIn(2)]);
  await settle();
  let done = false;
  void walk.then(() => (done = true));
  await settle();
  assert(!done, "a later answer does not settle the walk while an earlier window is still out");
  c.pending.get(1)!.resolve([slotIn(1)]);
  eq(await walk, [slotIn(1)], "and the earlier window's days are the answer once it lands");
}

// ------------------------------------------------------------ failure is not empty

{
  const c = controlled();
  const walk = findNextAvailableSlots({ probes, wantDays: 1, zone: ZONE, compute: c.compute });
  await settle();
  c.pending.get(1)!.resolve([slotIn(1)]);
  c.pending.get(0)!.reject(new Error("busy_blocks read failed"));
  let err: unknown = null;
  try {
    await walk;
  } catch (e) {
    err = e;
  }
  assert(err instanceof Error, "a failing earlier window rejects the walk rather than answering from a later one");
  eq((err as Error | null)?.message, "busy_blocks read failed", "and the rejection is that window's own error");
}

{
  // Every window empty except one that throws: the walk must NOT come back as
  // "nothing available", which would tell a lead we have no times.
  const c = controlled();
  const walk = findNextAvailableSlots({ probes, wantDays: 4, zone: ZONE, compute: c.compute });
  let outcome: "empty" | "error" | "pending" = "pending";
  let message = "";
  walk.then(
    (s) => (outcome = s.length === 0 ? "empty" : "pending"),
    (e: Error) => {
      outcome = "error";
      message = e.message;
    },
  );
  for (let i = 0; i < probes.length; i++) {
    await settle();
    const d = c.pending.get(i);
    if (!d) break;
    if (i === 5) d.reject(new Error("count RPC failed"));
    else d.resolve([]);
  }
  await settle();
  eq(outcome, "error", "a failure mid walk surfaces as an error, never as an empty answer");
  eq(message, "count RPC failed", "carrying the failing window's reason");
}

{
  // A window AFTER the answer failing changes nothing: a serial walk would never
  // have run it, so its failure is not about the days being offered.
  const c = controlled();
  const walk = findNextAvailableSlots({ probes, wantDays: 1, zone: ZONE, compute: c.compute });
  await settle();
  c.pending.get(1)!.reject(new Error("later window failed"));
  await settle();
  c.pending.get(0)!.resolve([slotIn(0)]);
  eq(await walk, [slotIn(0)], "a failure beyond the answer does not undo the answer");
}

{
  // A compute that throws synchronously is still an error, not a crash of the walk.
  const walk = findNextAvailableSlots({
    probes,
    wantDays: 1,
    zone: ZONE,
    compute: () => {
      throw new Error("sync throw");
    },
  });
  let err: unknown = null;
  try {
    await walk;
  } catch (e) {
    err = e;
  }
  eq((err as Error | null)?.message, "sync throw", "a synchronous throw surfaces as the walk's error");
}

// ------------------------------------------------------------ the cap

{
  // Nothing bookable anywhere: the full walk, settled one window at a time in
  // reverse finishing order within each pair, counting what is in flight.
  const c = controlled();
  const walk = findNextAvailableSlots({ probes, wantDays: 4, zone: ZONE, compute: c.compute });
  for (let round = 0; round < probes.length * 2; round++) {
    await settle();
    const open = [...c.pending.entries()].filter(([i]) => c.started.includes(i));
    const next = open.pop();
    if (!next) break;
    next[1].resolve([]);
    c.pending.delete(next[0]);
  }
  eq(await walk, [], "the full walk with nothing bookable comes back empty");
  eq(c.maxInFlight, NEXT_WINDOW_CONCURRENCY, "never more than the cap in flight, and the cap is actually used");
  eq(c.started.length, probes.length, "every window was computed exactly once");
  eq(new Set(c.started).size, probes.length, "no window was computed twice");
}

{
  // Once an earlier window has the answer, no NEW window starts. What is already in
  // flight is ignored, so the waste is bounded by the cap.
  const c = controlled();
  const walk = findNextAvailableSlots({ probes, wantDays: 1, zone: ZONE, compute: c.compute });
  await settle();
  c.pending.get(0)!.resolve([slotIn(0)]);
  eq(await walk, [slotIn(0)], "the first window's answer comes back");
  await settle();
  assert(
    c.started.length <= NEXT_WINDOW_CONCURRENCY,
    `no window starts after the answer (started ${c.started.length}, cap ${NEXT_WINDOW_CONCURRENCY})`,
  );
  // The ignored window settling late, even by failing, must not escape as an
  // unhandled rejection.
  c.pending.get(1)?.reject(new Error("late failure, ignored"));
  await settle();
}

// ------------------------------------------------------------ the budget, on a fake clock

/**
 * A fake clock plus a fake single threaded isolate. A Worker runs one request's
 * JavaScript on one thread, so a window's COMPUTE cannot overlap another window's
 * compute; only its I/O (the busy_blocks pages, the count RPC) can overlap. So each
 * simulated window waits `ioMs` on the clock, then queues for the one core and
 * holds it for `cpuMs`. Modelling it as pure waiting would let the concurrency
 * claim a saving the platform cannot deliver.
 */
function fakeIsolate() {
  let now = 0;
  const timers: Array<{ at: number; fire: () => void }> = [];
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      timers.push({ at: now + ms, fire: r });
    });
  let core: Promise<void> = Promise.resolve();
  const onCore = (ms: number) => {
    const turn = core.then(() => sleep(ms));
    core = turn;
    return turn;
  };
  async function run<T>(p: Promise<T>): Promise<{ value: T; elapsedMs: number }> {
    let done = false;
    let value!: T;
    let error: unknown = null;
    p.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        error = e;
      },
    );
    for (;;) {
      await settle();
      if (done) break;
      timers.sort((a, b) => a.at - b.at);
      const t = timers.shift();
      if (!t) throw new Error("fake clock: nothing scheduled and the walk has not settled");
      now = t.at;
      t.fire();
    }
    if (error) throw error;
    return { value, elapsedMs: now };
  }
  return { sleep, onCore, run };
}

/**
 * The split of one window's cost between I/O and compute, measured locally against
 * live data for bucket 100 (80 members) on 2026-09-25: about 330ms of reads and
 * 870ms of `computeBucketSlots` per window, so roughly 30% I/O.
 */
const IO_SHARE = 0.3;

async function simulateFullWalk(concurrency: number): Promise<number> {
  const iso = fakeIsolate();
  const ioMs = NEXT_WINDOW_COST_MS * IO_SHARE;
  const cpuMs = NEXT_WINDOW_COST_MS - ioMs;
  const { value, elapsedMs } = await iso.run(
    findNextAvailableSlots({
      probes,
      wantDays: 4,
      zone: ZONE,
      concurrency,
      compute: async () => {
        await iso.sleep(ioMs);
        await iso.onCore(cpuMs);
        return []; // nothing bookable: the walk visits every window
      },
    }),
  );
  eq(value, [], `the simulated walk at concurrency ${concurrency} found nothing, so it visited every window`);
  return elapsedMs;
}

{
  const serialMs = await simulateFullWalk(1);
  eq(serialMs, NEXT_WALK_WORST_CASE_MS, "one at a time, the full Low walk costs the stated worst case");

  const concurrentMs = await simulateFullWalk(NEXT_WINDOW_CONCURRENCY);
  assert(
    concurrentMs < serialMs,
    `running windows together is faster than one at a time (${concurrentMs}ms against ${serialMs}ms)`,
  );
  assert(
    concurrentMs * 1.5 <= NEXT_DAYS_TIMEOUT_MS,
    `the full Low walk (${concurrentMs}ms) finishes inside the booker's timeout (${NEXT_DAYS_TIMEOUT_MS}ms) with half again to spare`,
  );
  // And the old ceiling was genuinely too short for it, which is the bug.
  assert(
    serialMs >= REQUEST_TIMEOUT_MS,
    "the serial walk reached the shared 20s ceiling, which is what #2799 reported",
  );
}

finish();

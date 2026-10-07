// Many confirms for one agent's slot at once, against the real orchestration
// (#3221).
//
// The 2026-10-04 burst sent 100 confirms for one slot in a pool of one agent
// within 82ms, and every one of them came back 503 after 14 to 15.6 seconds with
// nobody booked. Nothing on the create path takes a lock: the only places two
// confirms for one slot meet are the unique and overlap indexes at the INSERT,
// the very last write. Until a confirm reaches it, it is an independent request
// that shares only capacity with the others: the isolate's CPU, which a Worker
// gives to every request it is serving at once, and the database, whose
// connections every request queues for.
//
// So this models exactly those two things and nothing else:
//
//   - every dependency call (each Supabase read or write, each Google call) is
//     one unit of work on a SHARED resource with a fixed capacity, served first
//     come first served, so a hundred requests progress together at a hundredth
//     of the speed rather than one after another;
//   - the bookings table's unique index on (agent, start), which refuses the
//     second insert for a slot, and the confirm slot claims, which refuse a
//     second claim on a key another request holds.
//
// Each call asks the REAL call budget (`call-budget.ts`) for its deadline, as
// the Supabase and Google clients do: a call that cannot finish before the
// confirm's 12 seconds run out is abandoned at the deadline with the real
// `DeadlineExceededError`, and one that starts after it is refused at once.
//
// Time is virtual. The clock only moves when every request is waiting, so a run
// of a hundred confirms over a simulated 15 seconds takes milliseconds, and the
// same inputs always give the same answer.
//
// "Every request is waiting" is a condition the clock measures, never a number of
// event loop turns it assumes. The confirm path does real asynchronous work the
// clock cannot see: `deterministicEventId` hashes through `crypto.subtle.digest`,
// which Node runs on the libuv threadpool and answers in REAL time. The first
// version of this loop yielded a fixed 20 turns and then moved the clock. On an
// idle machine the hash answers inside those turns; on a loaded CI runner it did
// not, so the clock jumped to the next timer while a confirm was still hashing,
// the queue's 6 second waits fired for every follower, and the burst came back
// 503 or "hung" (main run 37227801023, both attempts). So the clock watches, with
// an async hook, every timer, immediate and native request the code under test
// starts, and moves only once none is outstanding, waiting in real time for them
// and failing loudly, naming each one, if they outlast `realWaitCapMs`.
//
// Not named test-*.ts: the runner globs that pattern as a suite, so this file is
// a library the suite imports.
import type { BookingDeps } from "../../src/lib/booking/orchestration.ts";
import { DeadlineExceededError } from "../../src/lib/fetch-within-deadline.ts";
import { deadlineWithinBudget } from "../../src/lib/call-budget.ts";
import { createHook } from "node:async_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

/** This checkout, as stack frames spell it, so only work started by the repo's own
 *  code is watched (never a runner's or a preload's). */
const REPO_URL = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../..")).href;

/** How long the clock waits in real time for outstanding real work by default. A
 *  hash on a loaded runner takes milliseconds; this is the bound past which the
 *  work is not slow but stuck, and the run says so rather than guessing. */
export const REAL_WAIT_CAP_MS = 5_000;

/**
 * Real asynchronous work in flight that the code under test started: every
 * resource except promises (they settle in the microtask checkpoint a turn
 * already drains) and next ticks (drained in the same checkpoint), keyed by
 * async id and removed when Node destroys it. `quiet` is set while the clock
 * schedules its own turns, which are not work to wait for.
 */
const outstanding = new Map<number, { type: string; at: string }>();
let quiet = false;
let watching = false;
function watchRealWork(): void {
  if (watching) return;
  watching = true;
  createHook({
    init(asyncId, type) {
      if (quiet || type === "PROMISE" || type === "TickObject") return;
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      const stack = new Error().stack ?? "";
      Error.stackTraceLimit = limit;
      const frames = stack.split("\n").filter((l) => l.includes(REPO_URL) && !l.includes("confirm-contention-sim.ts"));
      if (frames.length === 0) return;
      outstanding.set(asyncId, { type, at: frames[0].trim().replace(/^at /, "").replace(REPO_URL, "") });
    },
    destroy(asyncId) {
      outstanding.delete(asyncId);
    },
  }).enable();
}

/** One turn of the event loop that the clock itself schedules, and so never waits on. */
function ownTurn(kind: "immediate" | "pause"): Promise<void> {
  quiet = true;
  try {
    return new Promise((r) => (kind === "immediate" ? setImmediate(r) : setTimeout(r, 1)));
  } finally {
    quiet = false;
  }
}

/** A clock that moves only when nothing can run, so time is spent waiting. */
export class VirtualClock {
  now: number;
  private timers: { at: number; seq: number; fire: () => void }[] = [];
  private seq = 0;
  private readonly realWaitCapMs: number;
  constructor(startMs: number, opts: { realWaitCapMs?: number } = {}) {
    this.now = startMs;
    this.realWaitCapMs = opts.realWaitCapMs ?? REAL_WAIT_CAP_MS;
    watchRealWork();
  }
  at(atMs: number, fire: () => void): () => void {
    const timer = { at: Math.max(atMs, this.now), seq: this.seq++, fire };
    this.timers.push(timer);
    return () => {
      const i = this.timers.indexOf(timer);
      if (i >= 0) this.timers.splice(i, 1);
    };
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.at(this.now + ms, resolve));
  }
  /**
   * Returns once nothing but the virtual clock can make progress: every microtask
   * has run and no real timer, immediate or native request the code under test
   * started is still outstanding. One turn drains every microtask and next tick
   * queued so far, and anything that could outlive a turn is a resource the hook
   * sees, so an empty `outstanding` after a turn is the condition itself.
   */
  async settle(): Promise<void> {
    const since = performance.now();
    for (;;) {
      await ownTurn("immediate");
      if (outstanding.size === 0) return;
      const waited = performance.now() - since;
      if (waited > this.realWaitCapMs) {
        const what = [...outstanding.values()].map((o) => `${o.type} at ${o.at}`).join("; ");
        throw new Error(
          `simulation stalled: real work the clock cannot move past was still outstanding after ${Math.round(waited)}ms: ${what}`,
        );
      }
      await ownTurn("pause");
    }
  }

  /** Lets every runnable continuation run, then moves to the next timer, until
   *  `done` says so. A run with nothing scheduled and nothing done is a hang. */
  async runUntil(done: () => boolean): Promise<void> {
    for (;;) {
      await this.settle();
      if (done()) return;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift();
      if (!next) throw new Error("simulation hung: nothing scheduled and the requests are not done");
      this.now = next.at;
      next.fire();
    }
  }
}

/** One dependency call as it happened: when it was asked for, how long it queued
 *  for the shared resource, and whether it finished. */
export interface CallRecord {
  name: string;
  askedAt: number;
  queuedMs: number;
  served: boolean;
  timedOut: boolean;
}

/** A call record for `name`, asked for at this instant and not yet served. */
function callRecordNow(name: string, clock: VirtualClock): CallRecord {
  return { name, askedAt: clock.now, queuedMs: 0, served: false, timedOut: false };
}

/**
 * Shared capacity: `capacity` calls in service at once, each taking `serviceMs`,
 * the rest queued in arrival order. A call whose deadline passes while it waits or
 * is served is abandoned there, as the real fetch is aborted at its deadline; a
 * call already in service keeps its unit busy until it would have finished, as a
 * statement the client gave up on still runs on the server.
 */
export class SharedResource {
  private busy = 0;
  private queue: { start: () => void }[] = [];
  private readonly clock: VirtualClock;
  private readonly capacity: number;
  /** How long one unit of work holds one unit of capacity. */
  readonly serviceMs: number;
  constructor(clock: VirtualClock, capacity: number, serviceMs: number) {
    this.clock = clock;
    this.capacity = capacity;
    this.serviceMs = serviceMs;
  }
  /** `deadlineAt` of Infinity is work nobody abandons (#3489: deferred work after an answer). */
  use(record: CallRecord, deadlineAt: number, missed: () => Error): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const giveUp = !Number.isFinite(deadlineAt) ? () => {} : this.clock.at(deadlineAt, () => {
        if (settled) return;
        settled = true;
        record.timedOut = true;
        record.queuedMs = this.clock.now - record.askedAt;
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(missed());
      });
      const entry = {
        start: () => {
          this.busy++;
          if (!settled) record.queuedMs = this.clock.now - record.askedAt;
          this.clock.at(this.clock.now + this.serviceMs, () => {
            this.busy--;
            this.next();
            if (settled) return;
            settled = true;
            giveUp();
            record.served = true;
            resolve();
          });
        },
      };
      this.queue.push(entry);
      this.next();
    });
  }
  private next(): void {
    while (this.busy < this.capacity && this.queue.length > 0) this.queue.shift()!.start();
  }
}

/** The per call ceiling a real Supabase or Google call carries on its own. Inside
 *  the confirm budget, the budget's remainder is what bounds it. */
const OWN_CALL_MS = 8_000;

/**
 * #3489: what one database call costs in the load model (`confirm-load-model.ts`).
 *
 * A call is network time, which any number of calls spend at once, around
 * `queries` statements, each of which holds one of the database's slots for the
 * resource's `serviceMs` and queues for one when every slot is busy. Alone, a call
 * answers in `latencyMs`; in a crowd, its statements wait their turn, which is how
 * a hundred reads at once slow each other and slow the one confirm that is booking.
 */
export interface CallCost {
  /** End to end, with nothing queued ahead of it. */
  latencyMs: number;
  /** Statements it runs, one after another, each holding one slot. */
  queries: number;
}

/**
 * A pause on the virtual clock that the call's deadline cuts short, as a real fetch
 * is aborted at its deadline wherever it is (on the wire as much as in a queue).
 */
function pauseWithin(clock: VirtualClock, ms: number, deadlineAt: number, record: CallRecord, missed: () => Error): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const giveUp = !Number.isFinite(deadlineAt)
      ? () => {}
      : clock.at(deadlineAt, () => {
          if (settled) return;
          settled = true;
          record.timedOut = true;
          reject(missed());
        });
    clock.at(clock.now + ms, () => {
      if (settled) return;
      settled = true;
      giveUp();
      resolve();
    });
  });
}

/** One call's network and statements, in that order of time: half the network out,
 *  the statements, half the network back. */
async function spend(
  clock: VirtualClock,
  resource: SharedResource,
  cost: CallCost,
  record: CallRecord,
  deadlineAt: number,
  missed: () => Error,
): Promise<void> {
  const networkMs = Math.max(0, cost.latencyMs - cost.queries * resource.serviceMs);
  await pauseWithin(clock, networkMs / 2, deadlineAt, record, missed);
  for (let q = 0; q < cost.queries; q++) {
    const one = callRecordNow(record.name, clock);
    try {
      await resource.use(one, deadlineAt, missed);
    } finally {
      record.queuedMs += one.queuedMs;
      if (one.timedOut) record.timedOut = true;
    }
  }
  await pauseWithin(clock, networkMs / 2, deadlineAt, record, missed);
}

/**
 * #3489: work a request does on the database AFTER it has answered (the outcome
 * tally, the failure page, the slot cache refresh), which no budget cuts off. It
 * finishes whenever the queue lets it, and every confirm still booking queues behind
 * it, which is how a crowd answered at once slows the next leader's commit.
 */
export function occupy(clock: VirtualClock, resource: SharedResource, cost: CallCost, name: string): Promise<void> {
  const record = callRecordNow(name, clock);
  return spend(clock, resource, cost, record, Infinity, () => new Error("deferred work is never cut off")).then(() => {
    record.served = true;
  });
}

/**
 * #3489: the shared confirm line's object as a confirm reaches it: a round trip on
 * every message, and an object that answers nothing until it is up (a fresh object,
 * or one the platform has to place, answered its first call in about a second in
 * load run 37640583621). A message is handled when it ARRIVES, so a poll the object
 * holds is answered as soon as the object answers it, plus the trip back.
 */
export function objectOnClock(
  clock: VirtualClock,
  reach: { roundTripMs: number; firstAnswerMs: number },
  handle: (message: Record<string, unknown>) => Promise<string>,
): (message: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const oneWay = reach.roundTripMs / 2;
  let upAt: number | null = null;
  return async (message) => {
    // The first message starts the object; it answers that one `firstAnswerMs` after
    // it was sent, so it is up a one way trip before that.
    if (upAt === null) upAt = clock.now + Math.max(oneWay, reach.firstAnswerMs - oneWay);
    const arrives = Math.max(clock.now + oneWay, upAt);
    await clock.sleep(arrives - clock.now);
    const answer = await handle(JSON.parse(JSON.stringify(message)) as Record<string, unknown>);
    await clock.sleep(oneWay);
    return JSON.parse(answer) as Record<string, unknown>;
  };
}

/**
 * Every asynchronous dependency of `deps`, made to cost one unit of the shared
 * resource and to keep the real budget's deadline. The fake's own behaviour runs
 * when the call is SERVED, so a write lands at the moment the database would
 * commit it, never while the call is still queued.
 *
 * #3489: with `costOf`, each call costs what the load model says instead: null is a
 * call that never touches the database (Google, whose time the fake itself spends,
 * and anything that is not I/O on it), still refused at once when the budget is
 * spent; a cost is network around statements on the database's slots (`CallCost`).
 */
export function onSharedCapacity(
  deps: BookingDeps,
  resource: SharedResource,
  clock: VirtualClock,
  calls: CallRecord[],
  /** Dependencies that are not I/O at all and must stay synchronous. */
  synchronous: ReadonlySet<string>,
  costOf?: (name: string, args: unknown[]) => CallCost | null,
): BookingDeps {
  const wrapped: Record<string, unknown> = { ...deps };
  for (const [name, value] of Object.entries(deps)) {
    if (typeof value !== "function" || synchronous.has(name)) continue;
    const original = value as (...args: unknown[]) => unknown;
    wrapped[name] = async (...args: unknown[]) => {
      const record = callRecordNow(name, clock);
      calls.push(record);
      // Refused at once when the budget is already spent, exactly as the real
      // clients are; otherwise waits no longer than the budget has left.
      const { waitMs, reportAs } = deadlineWithinBudget(OWN_CALL_MS, name, () => clock.now);
      const missed = () => new DeadlineExceededError(reportAs.label, reportAs.timeoutMs, reportAs.budget);
      if (!costOf) {
        await resource.use(record, clock.now + waitMs, missed);
        return original(...args);
      }
      const cost = costOf(name, args);
      if (cost) await spend(clock, resource, cost, record, clock.now + waitMs, missed);
      record.served = true;
      return original(...args);
    };
  }
  return wrapped as unknown as BookingDeps;
}

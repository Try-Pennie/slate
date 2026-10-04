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
// Not named test-*.ts: the runner globs that pattern as a suite, so this file is
// a library the suite imports.
import type { BookingDeps } from "../../src/lib/booking/orchestration.ts";
import { DeadlineExceededError } from "../../src/lib/fetch-within-deadline.ts";
import { deadlineWithinBudget } from "../../src/lib/call-budget.ts";

/** A clock that moves only when nothing can run, so time is spent waiting. */
export class VirtualClock {
  now: number;
  private timers: { at: number; seq: number; fire: () => void }[] = [];
  private seq = 0;
  constructor(startMs: number) {
    this.now = startMs;
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
  /** Lets every runnable continuation run, then moves to the next timer, until
   *  `done` says so. A run with nothing scheduled and nothing done is a hang. */
  async runUntil(done: () => boolean): Promise<void> {
    for (;;) {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
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
  private readonly serviceMs: number;
  constructor(clock: VirtualClock, capacity: number, serviceMs: number) {
    this.clock = clock;
    this.capacity = capacity;
    this.serviceMs = serviceMs;
  }
  use(record: CallRecord, deadlineAt: number, missed: () => Error): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const giveUp = this.clock.at(deadlineAt, () => {
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
 * Every asynchronous dependency of `deps`, made to cost one unit of the shared
 * resource and to keep the real budget's deadline. The fake's own behaviour runs
 * when the call is SERVED, so a write lands at the moment the database would
 * commit it, never while the call is still queued.
 */
export function onSharedCapacity(
  deps: BookingDeps,
  resource: SharedResource,
  clock: VirtualClock,
  calls: CallRecord[],
  /** Dependencies that are not I/O at all and must stay synchronous. */
  synchronous: ReadonlySet<string>,
): BookingDeps {
  const wrapped: Record<string, unknown> = { ...deps };
  for (const [name, value] of Object.entries(deps)) {
    if (typeof value !== "function" || synchronous.has(name)) continue;
    const original = value as (...args: unknown[]) => unknown;
    wrapped[name] = async (...args: unknown[]) => {
      const record: CallRecord = { name, askedAt: clock.now, queuedMs: 0, served: false, timedOut: false };
      calls.push(record);
      // Refused at once when the budget is already spent, exactly as the real
      // clients are; otherwise waits no longer than the budget has left.
      const { waitMs, reportAs } = deadlineWithinBudget(OWN_CALL_MS, name, () => clock.now);
      await resource.use(
        record,
        clock.now + waitMs,
        () => new DeadlineExceededError(reportAs.label, reportAs.timeoutMs, reportAs.budget),
      );
      return original(...args);
    };
  }
  return wrapped as unknown as BookingDeps;
}

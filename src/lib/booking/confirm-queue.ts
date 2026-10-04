/**
 * One confirm at a time per slot, within an isolate (#3221).
 *
 * Nothing on the create path takes a lock, so two confirms for the same slot meet
 * only at the bookings indexes on the last write, after each has done the whole
 * path: the reads, verify on book, the reservation and the Google event. When a
 * hundred arrive at once (the 2026-10-04 burst), each runs that path with a
 * hundredth of the isolate, the 12 second budget runs out on all of them together,
 * and nobody is booked, the confirm that should have won included.
 *
 * So the confirms for one slot form a line. The first leads and runs as it always
 * did; the rest wait, costing nothing while they do. When the leader's own confirm
 * shows the slot is FULL (it booked the last advisor its rung had free, or it was
 * refused as taken), everybody waiting is answered at once with what took it and
 * does none of the work. Otherwise the next one leads with what the leader left,
 * so a pool of two books two and then answers the rest.
 *
 * A confirm joins the line BEFORE its first read whenever the line is known from
 * the request (#3257, `queueKeyBeforeRouting`), so a follower answered from the
 * leader's verdict has read nothing at all. On 2026-10-04 (run 37229344882) the
 * line sat behind the bucket, person and idempotency reads, and those timed out on
 * every one of a hundred confirms before any of them reached it.
 *
 * A follower waits for the leader's verdict at most `confirmLineWaitMs`: what its
 * own confirm budget has left, less `CONFIRM_QUEUE_RESERVE_MS`, and never more
 * than `CONFIRM_QUEUE_WAIT_MS`. One whose wait runs out is told so by the caller
 * with a retryable answer, rather than starting a chain it has no time to finish
 * (#3257). The line can delay a confirm, never strand one, and a slow leader
 * cannot make its followers miss their budget.
 *
 * The line is per ISOLATE, held in module state, because the contention measured
 * was capacity inside one: a confirm that lost a race on its own cost about 250ms
 * of CPU, so a hundred at once are about 25 seconds of work for one isolate.
 * Confirms that land on different isolates still meet at the indexes, as before.
 */
import { realTimer, type ScheduleTimer } from "../read-within-deadline.ts";

/**
 * What a follower keeps back from its confirm budget while it waits (#3257): room
 * for the short chain of a lead who already holds the time (their own person
 * check and the answer it gives) and for the answer itself.
 */
export const CONFIRM_QUEUE_RESERVE_MS = 2_000;

/**
 * The longest a follower waits for the confirm ahead of it (#3257).
 *
 * Sized from two numbers that cannot both be met. A production confirm answers at
 * 7.4 to 8.0 seconds at the median (#3221, invocation wall time for POST /booking,
 * live Google), so a wait shorter than that sends every follower off on its own
 * while the leader is still working, which is the stampede the line exists to stop;
 * the first version waited 6 seconds and did exactly that. And the confirm budget is
 * 12 seconds (`BOOKING_CONFIRM_BUDGET_MS`), so a follower that waited 8 seconds has
 * no room left to run an 8 second chain of its own. So the wait is the budget less
 * the reserve, 10 seconds, and a follower whose wait runs out answers retryably from
 * the reserve instead of starting work it cannot finish. Kept as a literal because
 * `confirm-budget.ts` imports the orchestration that imports this module; the
 * relation is pinned by `scripts/test-confirm-queue.ts`.
 */
export const CONFIRM_QUEUE_WAIT_MS = 10_000;

/**
 * How long THIS follower waits: what its budget has left less the reserve, capped
 * at `CONFIRM_QUEUE_WAIT_MS`, and never negative. `budgetLeftMs` is null outside
 * any budget, where the cap alone applies. The route's own reads (the key and the
 * rate limits) spend part of the budget before the line is reached, which is why
 * this is measured rather than assumed.
 */
export function confirmLineWaitMs(budgetLeftMs: number | null): number {
  if (budgetLeftMs === null) return CONFIRM_QUEUE_WAIT_MS;
  return Math.max(0, Math.min(CONFIRM_QUEUE_WAIT_MS, budgetLeftMs - CONFIRM_QUEUE_RESERVE_MS));
}

/** What the leader's confirm showed about the slot when it finished. */
export type LeaderVerdict<T> =
  /** Nothing that settles the slot for anybody else: the next in line leads. */
  | { full: false }
  /**
   * The slot is full for everybody in line. `refusal` says how the leader learnt
   * it: `race` when it booked the last free advisor (the followers lost a race to
   * it), `taken` when it was itself refused as taken. `settled` is what the leader
   * hands its followers so each can tell whether the verdict really is about them:
   * its own booking for a double submit, who already sits at the instant for a lead
   * who holds the time (#3257).
   */
  | { full: true; refusal: "race" | "taken"; settled: T | null };

export type QueueTurn<T> =
  /** Run the confirm, then report what it showed, exactly once. `waiting` is how
   *  many are in line behind it right now, so a leader reads only for a crowd. */
  | { kind: "lead"; done(verdict: LeaderVerdict<T>): void; waiting(): number }
  /** The confirm ahead settled the slot: answer without doing the work. */
  | { kind: "refused"; refusal: "race" | "taken"; settled: T | null }
  /** Waited the whole bound without a verdict: the caller decides what it answers. */
  | { kind: "unqueued" };

export interface ConfirmQueue<T> {
  /** `waitMs` overrides the queue's own bound for this one follower. */
  enter(key: string, waitMs?: number): Promise<QueueTurn<T>>;
}

interface Waiter<T> {
  answer(turn: QueueTurn<T>): void;
}

export function makeConfirmQueue<T>(
  opts: { waitMs?: number; timer?: ScheduleTimer } = {},
): ConfirmQueue<T> {
  const waitMs = opts.waitMs ?? CONFIRM_QUEUE_WAIT_MS;
  const timer = opts.timer ?? realTimer;
  // A key is present while somebody leads it; its array is who is waiting.
  const lines = new Map<string, Waiter<T>[]>();

  const leadTurn = (key: string, waiting: Waiter<T>[]): QueueTurn<T> => {
    let reported = false;
    return {
      kind: "lead",
      waiting: () => waiting.length,
      done(verdict) {
        if (reported) return;
        reported = true;
        if (verdict.full) {
          lines.delete(key);
          for (const w of waiting.splice(0)) w.answer({ kind: "refused", refusal: verdict.refusal, settled: verdict.settled });
          return;
        }
        const next = waiting.shift();
        if (!next) {
          lines.delete(key);
          return;
        }
        next.answer(leadTurn(key, waiting));
      },
    };
  };

  return {
    enter(key, ownWaitMs) {
      const waiting = lines.get(key);
      if (!waiting) {
        const fresh: Waiter<T>[] = [];
        lines.set(key, fresh);
        return Promise.resolve(leadTurn(key, fresh));
      }
      return new Promise<QueueTurn<T>>((resolve) => {
        let settled = false;
        const waiter: Waiter<T> = {
          answer(turn) {
            if (settled) return;
            settled = true;
            cancel();
            resolve(turn);
          },
        };
        const cancel = timer(ownWaitMs ?? waitMs, () => {
          if (settled) return;
          settled = true;
          const i = waiting.indexOf(waiter);
          if (i >= 0) waiting.splice(i, 1);
          resolve({ kind: "unqueued" });
        });
        waiting.push(waiter);
      });
    },
  };
}

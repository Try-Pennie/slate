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
 * A follower waits at most `CONFIRM_QUEUE_WAIT_MS` and then runs on its own,
 * exactly as it would have without the line. The line can delay a confirm, never
 * strand one, and a slow leader cannot make its followers miss their budget.
 *
 * The line is per ISOLATE, held in module state, because the contention measured
 * was capacity inside one: a confirm that lost a race on its own cost about 250ms
 * of CPU, so a hundred at once are about 25 seconds of work for one isolate.
 * Confirms that land on different isolates still meet at the indexes, as before.
 */
import { realTimer, type ScheduleTimer } from "../read-within-deadline.ts";

/**
 * How long a follower waits for the confirm ahead of it before running on its own.
 * Half the confirm budget (12 seconds, `confirm-budget.ts`), so one that gives up
 * still has half its budget for a confirm of its own. Pinned by
 * `scripts/test-confirm-queue.ts`.
 */
export const CONFIRM_QUEUE_WAIT_MS = 6_000;

/** What the leader's confirm showed about the slot when it finished. */
export type LeaderVerdict<T> =
  /** Nothing that settles the slot for anybody else: the next in line leads. */
  | { full: false }
  /**
   * The slot is full for everybody in line. `refusal` says how the leader learnt
   * it: `race` when it booked the last free advisor (the followers lost a race to
   * it), `taken` when it was itself refused as taken. `taker` is what the follower
   * needs to recognise its OWN booking, a double submit that must get it back.
   */
  | { full: true; refusal: "race" | "taken"; taker: T | null };

export type QueueTurn<T> =
  /** Run the confirm, then report what it showed, exactly once. */
  | { kind: "lead"; done(verdict: LeaderVerdict<T>): void }
  /** The confirm ahead settled the slot: answer without doing the work. */
  | { kind: "refused"; refusal: "race" | "taken"; taker: T | null }
  /** Waited the whole bound: run on its own, outside the line. */
  | { kind: "unqueued" };

export interface ConfirmQueue<T> {
  enter(key: string): Promise<QueueTurn<T>>;
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
      done(verdict) {
        if (reported) return;
        reported = true;
        if (verdict.full) {
          lines.delete(key);
          for (const w of waiting.splice(0)) w.answer({ kind: "refused", refusal: verdict.refusal, taker: verdict.taker });
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
    enter(key) {
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
        const cancel = timer(waitMs, () => {
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

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
 * A leader that has claimed an advisor while another unclaimed one remains hands
 * the line on at once (#3257, `LineSeat`), so concurrent confirms for a time in a
 * big pool run side by side on different advisors rather than one after another.
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

/**
 * A leader's place among the confirms in flight for its slot (#3257).
 *
 * Ordinary traffic for a popular time in a big pool must not wait in line: two
 * leads booking 9:00 in a pool of twenty can both be served at once, and on the
 * 2026-10-04 measurements a confirm that waited for one ahead of it at production
 * speed (7.4 to 8.0s) ran out of budget, while one that ran beside it picked the
 * same top advisor, lost the insert race and ran out of budget reassigning. So a
 * leader CLAIMS the advisor it is about to book, and as soon as it has claimed one
 * while another unclaimed advisor remains, it hands the line on: the next confirm
 * leads at once and books from the advisors nobody in flight has claimed. A crowd
 * for the LAST advisor never hands on, so it still has exactly one winner.
 */
export interface LineSeat {
  /** Advisors other confirms in this line have claimed and not yet finished with. */
  claimedByOthers(): ReadonlySet<string>;
  /**
   * This confirm is booking `userId`. A confirm books one advisor, so it holds one
   * claim: a later call (Google found the first busy, or a lost race moved it on)
   * REPLACES the claim, releasing the advisor it held before. When `othersRemain`,
   * an advisor nobody has claimed is still there for the next confirm, so the line
   * is handed on now rather than when this one finishes.
   */
  claim(userId: string, othersRemain: boolean): void;
  /**
   * This confirm will take NO advisor at this time (#3257): the direct booking
   * API found the lead already holds it, or must ask them before moving. The line
   * is handed on at once, so its arm never holds up a lead booking for real.
   */
  pass(): void;
}

/**
 * How many confirms arriving at a BUSY line may each make one cheap read of their
 * own before joining it (#3257), so a replay of a booking that already exists is
 * answered at once rather than waiting behind a confirm that is still booking.
 * Bounded per line, because a hundred such reads at once are the crowd the line
 * exists to hold back; the rest join the line and are answered from its verdict.
 */
export const CONFIRM_LINE_LOOKAHEAD = 2;

export type QueueTurn<T> =
  /**
   * Run the confirm, then report what it showed, exactly once. `waiting` is how
   * many are in line behind it right now, so a leader reads only for a crowd.
   * `seat` is its claim on an advisor (see `LineSeat`).
   */
  | { kind: "lead"; done(verdict: LeaderVerdict<T>): void; waiting(): number; seat: LineSeat }
  /** The confirm ahead settled the slot: answer without doing the work. */
  | { kind: "refused"; refusal: "race" | "taken"; settled: T | null }
  /** Waited the whole bound without a verdict: the caller decides what it answers. */
  | { kind: "unqueued" };

export interface ConfirmQueue<T> {
  /** `waitMs` overrides the queue's own bound for this one follower. */
  enter(key: string, waitMs?: number): Promise<QueueTurn<T>>;
  /**
   * Permission to make one cheap read before joining a BUSY line, as a function
   * that gives the permission back (call it exactly once), or null: the line is
   * idle, so just enter and lead, or `CONFIRM_LINE_LOOKAHEAD` reads are already in
   * flight on it, so wait in line like the rest.
   */
  lookahead(key: string): (() => void) | null;
}

interface Waiter<T> {
  answer(turn: QueueTurn<T>): void;
}

/**
 * One slot's line. `holder` is the leader that has NOT handed on, whom the
 * waiting are behind; null when every leader in flight has handed on, so the
 * next to arrive leads at once. `claims` is the advisor each leader in flight is
 * booking.
 */
interface Line<T> {
  waiting: Waiter<T>[];
  holder: object | null;
  claims: Map<object, string | null>;
  /** Cheap reads in flight ahead of joining this line (`lookahead`). */
  looking: number;
}

export function makeConfirmQueue<T>(
  opts: { waitMs?: number; timer?: ScheduleTimer } = {},
): ConfirmQueue<T> {
  const waitMs = opts.waitMs ?? CONFIRM_QUEUE_WAIT_MS;
  const timer = opts.timer ?? realTimer;
  // A key is present while somebody leads it or waits in it.
  const lines = new Map<string, Line<T>>();
  // Removes THIS line only: a lookahead returned after its line settled must not
  // delete a newer line that has since been opened under the same key.
  const drop = (key: string, line: Line<T>) => {
    if (lines.get(key) === line) lines.delete(key);
  };
  // The one test for a line nobody needs any more: nobody leading it without
  // having handed on, nobody waiting, no claim in flight, no lookahead out.
  const dropIfIdle = (key: string, line: Line<T>) => {
    if (line.holder === null && line.waiting.length === 0 && line.claims.size === 0 && line.looking === 0) {
      drop(key, line);
    }
  };

  const promoteNext = (key: string, line: Line<T>): void => {
    if (line.holder !== null) return;
    const next = line.waiting.shift();
    if (next) {
      next.answer(leadTurn(key, line));
      return;
    }
    dropIfIdle(key, line);
  };

  const leadTurn = (key: string, line: Line<T>): QueueTurn<T> => {
    const me = {};
    let reported = false;
    line.holder = me;
    line.claims.set(me, null);
    const handOn = () => {
      if (line.holder !== me) return;
      line.holder = null;
      promoteNext(key, line);
    };
    return {
      kind: "lead",
      waiting: () => line.waiting.length,
      seat: {
        claimedByOthers() {
          const others = new Set<string>();
          for (const [who, userId] of line.claims) if (who !== me && userId !== null) others.add(userId);
          return others;
        },
        claim(userId, othersRemain) {
          if (reported) return;
          line.claims.set(me, userId);
          if (othersRemain) handOn();
        },
        pass() {
          if (reported) return;
          line.claims.set(me, null);
          handOn();
        },
      },
      done(verdict) {
        if (reported) return;
        reported = true;
        line.claims.delete(me);
        if (line.holder === me) line.holder = null;
        // A full verdict settles the slot for the waiting only when no other
        // confirm is still booking in it: one in flight may yet fail and leave its
        // advisor free, so then the next in line asks for itself.
        if (verdict.full && line.claims.size === 0) {
          drop(key, line);
          for (const w of line.waiting.splice(0)) {
            w.answer({ kind: "refused", refusal: verdict.refusal, settled: verdict.settled });
          }
          return;
        }
        promoteNext(key, line);
      },
    };
  };

  return {
    enter(key, ownWaitMs) {
      const existing = lines.get(key);
      if (!existing) {
        const line: Line<T> = { waiting: [], holder: null, claims: new Map(), looking: 0 };
        lines.set(key, line);
        return Promise.resolve(leadTurn(key, line));
      }
      // Every leader in flight has handed on: nobody to wait behind.
      if (existing.holder === null && existing.waiting.length === 0) {
        return Promise.resolve(leadTurn(key, existing));
      }
      const line = existing;
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
          const i = line.waiting.indexOf(waiter);
          if (i >= 0) line.waiting.splice(i, 1);
          dropIfIdle(key, line);
          resolve({ kind: "unqueued" });
        });
        line.waiting.push(waiter);
      });
    },
    lookahead(key) {
      const line = lines.get(key);
      // An idle line, or one whose leaders have all handed on: entering leads at
      // once, so there is nothing to look ahead of.
      if (!line || (line.holder === null && line.waiting.length === 0)) return null;
      if (line.looking >= CONFIRM_LINE_LOOKAHEAD) return null;
      line.looking++;
      let returned = false;
      return () => {
        if (returned) return;
        returned = true;
        line.looking--;
        dropIfIdle(key, line);
      };
    },
  };
}

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
 * shows the slot is FULL, everybody waiting is answered at once with what took it
 * and does none of the work. Otherwise the next one leads with what the leader left,
 * so a pool of two books two and then answers the rest.
 *
 * FULL means the leader's whole tier LADDER is spent (#3338): it booked the last
 * advisor the ladder's last rung had free, or it was refused after every rung (a
 * lost race included, once nobody below it was free either). A leader that booked
 * the last advisor of a rung ABOVE the last leaves the rungs below it to the
 * confirms waiting, who walk them exactly as any confirm does (Dan, 2026-10-06:
 * "Same as a normal confirm"): the next one leads, walks from the top, finds the
 * booked rung spent in the write through cache, and books below. Before #3338 that
 * leader told everybody waiting the time was taken while the tier below had people
 * free. The rule for a full verdict is the confirm path's (`createHeld`,
 * `verdictForRefusal`); this module only honours it, under the same gate as
 * always: no other confirm still booking in the slot (`done`).
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
 * Sized from two numbers that cannot both be met. A production confirm answered at
 * 7.4 to 8.0 seconds at the median on 2026-10-04 (#3221, invocation wall time for
 * POST /booking, live Google). It takes about 1.6s now (#3490), but 8 seconds is
 * still the slow confirm the line must survive, so a wait shorter than that sends every follower off on its own
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
 * How long a leader's turn, and its claim on an advisor, lasts without a verdict
 * (#3274). A confirm torn down mid flight (a client disconnect cancelling the
 * invocation) may never call `done`, and nothing else ends its turn: its claim
 * would keep every later confirm in this isolate off that advisor for that slot,
 * and a leader that never handed on would keep the line behind it for good.
 *
 * So a turn is leased for the confirm budget plus its cleanup allowance, the
 * longest a real confirm can still be working (both are enforced deadlines, #3102),
 * after which the turn is ignored and dropped. Kept as a literal for the same reason
 * as `CONFIRM_QUEUE_WAIT_MS`; `scripts/test-confirm-queue.ts` pins it equal to
 * `BOOKING_CONFIRM_WORST_CASE_MS`.
 */
export const CONFIRM_CLAIM_LEASE_MS = 14_000;

/**
 * The most waiting confirms one leader's read releases at once (#3489). Each released
 * confirm runs a whole booking chain, and on the per isolate line every one of them
 * runs in THIS isolate: a confirm cost about 250ms of CPU (#3221), so 24 at once is
 * about six seconds of CPU, half the confirm budget, leaving the other half for what
 * else the isolate is serving. The largest rung a load run has handed out had 23
 * advisors free (run 37640583621, burst 2). A premise that can be re-measured: the
 * CPU a confirm costs, and the largest free rung a crowd meets.
 */
export const RELEASE_CAP = 24;

/**
 * How long a leader's read of a rung stays good enough to hand out (#3489). Every
 * handed advisor is read again, narrowed to that one advisor, before anything is
 * booked, so a stale entry costs a wasted read rather than a wrong booking; the bound
 * is the follower's whole wait, since a read older than that predates every confirm
 * still waiting.
 */
export const FRONTIER_FRESH_MS = CONFIRM_QUEUE_WAIT_MS;

/**
 * How long a line remembers the full verdict that settled it (#3570), so a confirm
 * arriving just after is answered from it as the crowd was, rather than leading a line
 * of its own and running the whole confirm to learn the same thing. Load run
 * 37977451270 met one on a fresh isolate: its start, a switch read giving up and a slow
 * ceiling put it at the line about 60ms after the verdict, and it answered 5.9s after
 * the last booking. Five seconds covers a fresh isolate's late start (1.3s to load the
 * app, 0.5s for the switch read to give up, 1.2s of auth in that run) with room over it.
 *
 * What it costs: while the line remembers, no confirm opens a line for the slot, so
 * nothing books at that instant through the line and the settlement (who sits there)
 * stays exact for it. Only a booking at the instant CANCELLED inside the window goes
 * unseen, and a lead arriving then is told the time is taken, as the cache-first
 * availability already tells leads for longer than that.
 */
export const CONFIRM_LINE_SETTLED_MEMORY_MS = 5_000;

/**
 * How a confirm's claim on an advisor ended (#3489), one value, never a boolean
 * (L163): only an advisor nobody tried is free for certain.
 *
 * - `booked`: the confirm holds a booking on it.
 * - `advisor-busy`: the live check found the advisor busy.
 * - `lost-race`: the insert found the advisor already taken at this time.
 * - `untried`: the confirm never asked anything about the advisor (its request ended
 *   first: a replay, a person gate, a client gone). The line knows this itself: an
 *   advisor is untried until the confirm says `trying`.
 * - `unknown`: anything else, an older client's report among it. Never handed on.
 */
export const CLAIM_OUTCOMES = ["booked", "advisor-busy", "lost-race", "untried", "unknown"] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

/** A claim outcome read off the wire, or undefined for anything else (read as `unknown`). */
export function readClaimOutcome(x: unknown): ClaimOutcome | undefined {
  return (CLAIM_OUTCOMES as readonly unknown[]).includes(x) ? (x as ClaimOutcome) : undefined;
}

/** Where a confirm reads its candidates from: the rung of its ladder, by position (#3489). */
export interface ClaimPlace {
  rung: number;
  /**
   * #3489 step 3: this confirm can walk on past a rung (a new booking's ladder walk, or
   * a lost race's), so a rung every candidate of which is claimed is SPENT to it, and
   * claiming a rung's last unclaimed advisor hands the line on so the confirms behind it
   * walk down at once (Dan, 2026-10-07: "Walk down straight away"). Never set for a
   * reschedule's reroute, a move or a named link, nor by an older client.
   */
  canWalk?: boolean;
  /**
   * #3489 step 3: the walk's ladder has a rung BELOW this one. Only then does claiming a
   * rung's last unclaimed advisor hand the line on: on the last rung there is nowhere for
   * the confirms behind it to walk, so handing on would only send one off to read for
   * nothing. Carried on the frontier, so a confirm the line hands that rung's last
   * advisor does not hold the line either.
   */
  below?: boolean;
  /**
   * #3529: the reads of the ladder's rungs BELOW `rung`, from the same ladder read, in
   * ladder order. The line hands them out in the same release as this rung, rung by rung,
   * so a crowd whose free advisors sit on several rungs starts all of them at once rather
   * than one rung a walker at a time. Absent from an older client, and then only `rung` is
   * handed out, as before.
   */
  lower?: readonly { rung: number; read: readonly string[] }[];
  /**
   * #3529: `lower` covers EVERY rung below `rung` that the read found anyone on: a rung
   * missing from it was read and found empty, and with no `lower` at all every rung below
   * was. The advisors on the deepest rung listed (or on `rung` itself, with none listed) are
   * then handed out marked `deepest` (`StartFrom.deepest`).
   */
  lowerComplete?: true;
}

/** What `claimFirst` answers: `spent` when a walker met a rung every candidate of which is claimed. */
export type ClaimFirstAnswer = {
  pool: string[];
  unclaimed: number;
  spent?: true;
  /** #3489 step 3: how many waited in the line as this claim was made. */
  waiting?: number;
};

/**
 * What a released confirm is handed (#3489): the rung, the advisor claimed for it, and
 * the leader's whole read of that rung in round robin order, which the confirm reasons
 * over (its full verdict, its lost race) instead of a list of one.
 */
export interface StartFrom {
  rung: number;
  advisor: string;
  read: readonly string[];
  /**
   * #3529: the read this was handed from covered the whole ladder below and found nobody
   * free below this rung, so for this confirm the rung stands for the ladder's last.
   */
  deepest?: true;
  /**
   * #3529: this is the last advisor the read it was handed from had unclaimed: every other
   * one on it is claimed or was handed before it. A rung's read ends wherever round robin put
   * its people, often with somebody a rung above holds and is handed on, so a confirm's place
   * in its read cannot say it took the last one (load run 37871606406); this can.
   */
  last?: true;
}

/**
 * A `StartFrom` read off the wire, or undefined when it is absent or not one: a whole
 * rung, an advisor id, and a read that holds that advisor. A confirm handed nothing
 * readable reads for itself, and its own claim then returns the advisor it was handed.
 */
export function readStartFrom(x: unknown): StartFrom | undefined {
  if (!x || typeof x !== "object") return undefined;
  const { rung, advisor, read } = x as Record<string, unknown>;
  if (typeof rung !== "number" || !Number.isInteger(rung) || rung < 0) return undefined;
  if (typeof advisor !== "string" || advisor.length === 0) return undefined;
  if (!Array.isArray(read) || !read.every((id) => typeof id === "string") || !read.includes(advisor)) return undefined;
  const deepest = (x as Record<string, unknown>).deepest === true;
  const last = (x as Record<string, unknown>).last === true;
  return { rung, advisor, read: read as string[], ...(deepest ? { deepest: true as const } : {}), ...(last ? { last: true as const } : {}) };
}

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
  /**
   * Nothing that settles the slot for anybody else: the next in line leads. `booked`
   * (#3489 step 3) is this confirm's own booking when it booked, so the settlement it
   * reports as it ends can carry it; it never travels to the line.
   */
  | { full: false; booked?: T }
  /**
   * The slot is full for everybody in line: the leader's whole ladder is spent
   * (#3338). `refusal` says how the leader learnt it: `race` when it booked the
   * last free advisor of the ladder's last rung (the followers lost a race to it),
   * or lost the insert race with nobody left below, `taken` when it was itself
   * refused as taken on every rung. `settled` is what the leader
   * hands its followers so each can tell whether the verdict really is about them:
   * its own booking for a double submit, who already sits at the instant for a lead
   * who holds the time (#3257).
   */
  | {
      full: true;
      refusal: "race" | "taken";
      settled: T | null;
      /**
       * #3529: full only if no claim has ended without a booking since this confirm
       * first read through the line (its first `claimFirst`). A confirm that walked past
       * claimed advisors cannot know whether one was freed since; the line can, by its
       * `epoch`. Void otherwise, and for a confirm that never read through the line.
       */
      unlessFreed?: true;
    };

/**
 * A leader's place among the confirms in flight for its slot (#3257).
 *
 * Ordinary traffic for a popular time in a big pool must not wait in line: two
 * leads booking 9:00 in a pool of twenty can both be served at once, and on the
 * 2026-10-04 measurements a confirm that waited for one ahead of it at that day's
 * production speed (7.4 to 8.0s) ran out of budget, while one that ran beside it picked the
 * same top advisor, lost the insert race and ran out of budget reassigning. So a
 * leader CLAIMS the advisor it is about to book, and as soon as it has claimed one
 * while another unclaimed advisor remains, it hands the line on: the next confirm
 * leads at once and books from the advisors nobody in flight has claimed. A crowd
 * for the LAST advisor never hands on, so it still has exactly one winner on that
 * rung; since #3338 the confirm behind it then walks to the rung below, if the
 * ladder has one, where the same rule hands on once per unclaimed advisor.
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
   * Read who else is claimed and claim, in ONE step (#3325). The candidates nobody
   * else in flight has claimed come first, in order (all of them when every one is
   * claimed, so the insert decides as before the line existed), and this confirm
   * claims the first of them, handing the line on when another unclaimed one
   * remains. One operation, because a line hosted in a shared object answers each
   * call over the network, and between a separate read and claim another leader
   * could claim the same advisor.
   */
  claimFirst(candidates: readonly string[], place?: ClaimPlace): ClaimFirstAnswer;
  /**
   * #3489: this confirm is about to ask Google about `userId`, so from now on its claim
   * is no longer untried (`ClaimOutcome`). A no op for an advisor it does not hold.
   */
  trying(userId: string): void;
  /**
   * Claim `userId` and hand the line on only when some advisor in `besides` other
   * than `userId` is unclaimed by anybody else (#3325): an in place move's rule,
   * read and decided in one step for the same reason as `claimFirst`.
   */
  claimBeside(userId: string, besides: readonly string[]): void;
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
  | {
      kind: "lead";
      /**
       * Reports the verdict and, since #3489, how this confirm's claim ended. With no
       * outcome (an older client) the claim ended `unknown`, never handed on.
       * `settlement`, read as this confirm ends (who sits at the instant now), is what a
       * pending full verdict this end completes is answered with (step 3); without one
       * the line never answers from a stale settlement, and one confirm reads instead.
       */
      done(verdict: LeaderVerdict<T>, outcome?: ClaimOutcome, settlement?: T): void;
      /**
       * #3489 step 3: this confirm walked its whole ladder and skipped a rung only because
       * every advisor on it is claimed by a confirm still in flight. It ends its turn
       * WITHOUT a verdict and waits again, at most `waitMs`, and the line holds a pending
       * full verdict for everybody waiting: applied when the last claim in flight ends
       * booked, discarded (one confirm reads again) when any claim ends otherwise.
       */
      park(waitMs?: number): Promise<QueueTurn<T>>;
      /** `park`, answered as a wait that can be cancelled (a host in a shared object
       *  drops a parked confirm whose caller stopped polling, as any waiter). */
      parkNow(waitMs?: number): Extract<EnteredNow<T>, { kind: "wait" }>;
      waiting(): number;
      seat: LineSeat;
      /**
       * #3489: set when the line RELEASED this confirm on a leader's read: the rung,
       * the advisor claimed for it, and the leader's whole read of that rung. Absent
       * for a confirm that leads and reads for itself.
       */
      start?: StartFrom;
      /**
       * #3489 step 3: set when a walker PARKED and every claim it walked past has since
       * ended booked, with nothing freed since it found the first of them (`epoch`). Its
       * own walk then proves the ladder spent: the rungs it read had nobody free and the
       * ones it skipped are booked. So it leads again at once and reports the ladder full
       * itself, rather than the next confirm walking the whole ladder again.
       */
      spent?: true;
      /**
       * Confirms this turn reached its caller (#3325). A host that requires it
       * (`ackMs`) ends a lead nobody acknowledges within that window, so an answer
       * its caller never received cannot hold the line. A no op otherwise.
       */
      ack(): void;
      /** Extends this turn's lease by `leaseMs` from now (#3325); a no op once it has ended. */
      renew(): void;
      /** False once it has reported or its lease has run out (#3325), so a host can say so. */
      alive(): boolean;
    }
  /** The confirm ahead settled the slot: answer without doing the work. */
  | { kind: "refused"; refusal: "race" | "taken"; settled: T | null }
  /** Waited the whole bound without a verdict: the caller decides what it answers. */
  | { kind: "unqueued" };

/**
 * What entering a line answers AT ONCE (#3325): the turn, when this confirm leads,
 * or a promise of its turn and a way to leave the line. A host in a shared object
 * answers its caller immediately, so the caller can tell an unreachable object from
 * a long line, and drops a waiter whose caller stopped asking, since nothing tells an
 * object that a request was cancelled. `cancel` is for a waiter whose caller is gone:
 * one still waiting leaves the line (answered unqueued), and one already promoted to
 * lead and never collected ends that lead as settling nothing, so the line is handed
 * on rather than held until the lease runs out. Never call it after collecting a lead.
 */
export type EnteredNow<T> =
  | { kind: "lead"; turn: Extract<QueueTurn<T>, { kind: "lead" }> }
  | { kind: "wait"; turn: Promise<QueueTurn<T>>; cancel(): void };

export interface ConfirmQueue<T> {
  /** `waitMs` overrides the queue's own bound for this one follower. */
  enter(key: string, waitMs?: number): Promise<QueueTurn<T>>;
  /** `enter`, answered synchronously (#3325). See `EnteredNow`. */
  enterNow(key: string, waitMs?: number): EnteredNow<T>;
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

/** One leader's claim (#3274, #3489). */
interface Claim {
  userId: string | null;
  until: number;
  /** It said `trying` for `userId`: the advisor is no longer untried. */
  tried: boolean;
  /** The line handed it this advisor (`StartFrom`); counted against `RELEASE_CAP`. */
  handed: boolean;
  /**
   * Its advisor came off the frontier (handed, or claimed with a `ClaimPlace`), so an
   * untried end puts it back. Never true for a move's `claimBeside` or an older client.
   */
  returnable: boolean;
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
  /** Each leader in flight: the advisor it claimed (or none yet) and when its lease ends (#3274). */
  claims: Map<object, Claim>;
  /**
   * #3489: the newest leader's read of a rung, the advisors on it in round robin order
   * and when it was read. Advisors leave it as their claims end anything but `untried`;
   * what nobody in flight has claimed is what the line can hand out.
   */
  frontier: {
    rung: number;
    read: string[];
    at: number;
    below: boolean;
    /**
     * #3529: the line's epoch when the confirm whose read this is first read through the
     * line. A confirm handed a lower rung never read the rungs above it, that confirm did,
     * so this is what vouches for them (`spentAt` of a handed turn).
     */
    readAt: number;
    /** #3529: the rungs below, as the same read found them (`ClaimPlace.lower`). */
    lower: { rung: number; read: string[] }[];
    /** #3529: `lower` covers every rung below that had anyone (`ClaimPlace.lowerComplete`). */
    lowerComplete: boolean;
  } | null;
  /** Cheap reads in flight ahead of joining this line (`lookahead`). */
  looking: number;
  /**
   * #3489 step 3: bumped by every claim on an advisor that ends in a way that may have left
   * the advisor FREE, so a pending verdict can tell whether anything that could free an
   * advisor has happened since. #3529: that is a claim ending untried or unknown (lapsed,
   * replaced untried, or a confirm that never said), and never one ending booked, found
   * busy or lost its race: Google said that advisor cannot take the time, or a booking
   * already holds them, so nobody else could book them either. Counting those (load run
   * 37822382352, burst 1) let a walker's own lost races void its walk, and a crowd timed out
   * while a second confirm walked the ladder again to find what the line already knew.
   */
  epoch: number;
  /**
   * #3489 step 3: a full verdict the line holds for everybody waiting, from a leader that
   * found the ladder spent while claims were still in flight, or a walker that parked.
   * Valid while `epoch` is unchanged and a claim is in flight; applied when the last of
   * them ends booked, with that end's settlement.
   */
  pending: { refusal: "race" | "taken"; epoch: number } | null;
}

/**
 * A real timer that never keeps a process alive by itself (#3274): a lease left by an
 * abandoned confirm must not hold a Node test run open for 14 seconds. `unref` exists
 * on Node's timers and not on a Worker's, where it is simply not called.
 */
const unreferencedTimer: ScheduleTimer = (ms, fire) => {
  const t = setTimeout(fire, ms) as unknown as { unref?: () => void };
  t.unref?.();
  return () => clearTimeout(t as unknown as Parameters<typeof clearTimeout>[0]);
};

export function makeConfirmQueue<T>(
  opts: {
    waitMs?: number;
    timer?: ScheduleTimer;
    /** The timer that ends each lead turn's lease (#3274), apart from the waits' so a
     *  test can fire one without the other. Defaults to an unreferenced real timer. */
    leaseTimer?: ScheduleTimer;
    now?: () => number;
    /**
     * How long a lead turn lasts without a report or a renewal. Defaults to
     * `CONFIRM_CLAIM_LEASE_MS`, right for one isolate, where a leader that dies takes
     * its whole invocation with it. A host in a shared object sets it short and has
     * its leaders renew (#3325), so an abandoned leader frees the line well inside the
     * followers' wait.
     */
    leaseMs?: number;
    /** When set, a new lead must `ack` within this many ms or it is ended (#3325). */
    ackMs?: number;
    /** How long a lookahead place may stay out before it is reclaimed (#3325). */
    lookaheadLeaseMs?: number;
    /** How long a full verdict answers confirms arriving after it settled the line (#3570). */
    settledMemoryMs?: number;
  } = {},
): ConfirmQueue<T> {
  const waitMs = opts.waitMs ?? CONFIRM_QUEUE_WAIT_MS;
  const timer = opts.timer ?? realTimer;
  const now = opts.now ?? (() => Date.now());
  const leaseTimer = opts.leaseTimer ?? unreferencedTimer;
  const leaseMs = opts.leaseMs ?? CONFIRM_CLAIM_LEASE_MS;
  const ackMs = opts.ackMs;
  const lookaheadLeaseMs = opts.lookaheadLeaseMs ?? CONFIRM_CLAIM_LEASE_MS;
  const settledMemoryMs = opts.settledMemoryMs ?? CONFIRM_LINE_SETTLED_MEMORY_MS;
  // A key is present while somebody leads it or waits in it.
  const lines = new Map<string, Line<T>>();
  // #3570: the full verdict that settled a key's line, and when, so a confirm arriving
  // just after is answered from it rather than leading a line of its own.
  const settledLately = new Map<string, { refusal: "race" | "taken"; settled: T | null; at: number }>();
  const rememberedFor = (key: string): { refusal: "race" | "taken"; settled: T | null } | null => {
    const t = now();
    for (const [k, m] of settledLately) if (t - m.at >= settledMemoryMs) settledLately.delete(k);
    return settledLately.get(key) ?? null;
  };
  // Removes THIS line only: a lookahead returned after its line settled must not
  // delete a newer line that has since been opened under the same key.
  const drop = (key: string, line: Line<T>) => {
    if (lines.get(key) === line) lines.delete(key);
  };
  // #3274: drop every leader whose lease has passed, as if it had reported nothing
  // that settles the slot. Run before anything reads the claims or the holder, so an
  // abandoned confirm can never be counted as booking an advisor or holding the line.
  // Returns whether any lapsed, so the caller can hand the line on.
  //
  // #3529: ANY lapsed claim, not only the holder's or one whose advisor went back on the
  // frontier. A lapse voids a pending verdict (its end is unknown, so the epoch moves) and
  // a handed one makes room under `RELEASE_CAP`, and either leaves somebody waiting with
  // nothing else to wake them before their own wait runs out. `promoteNext` does nothing
  // while a confirm still holds the line, so an extra call costs nothing.
  const expire = (line: Line<T>): boolean => {
    const t = now();
    let freed = false;
    for (const [who, c] of line.claims) {
      if (c.until > t) continue;
      // #3489: an expired claim said nothing about how it ended.
      endAdvisor(line, c, "unknown");
      line.claims.delete(who);
      if (line.holder === who) line.holder = null;
      freed = true;
    }
    return freed;
  };

  // #3489: the one rule for what an ended claim means for its advisor. An end the
  // confirm KNOWS (booked, found busy, lost the race) is taken as reported. Between
  // untried and unknown the line's own knowledge decides: a returnable claim that never
  // said `trying` is untried, and one that did can never be. Only an untried advisor
  // stays on the frontier; any other end takes it off. Returns whether an advisor went
  // back, so the caller can hand it out.
  const endAdvisor = (line: Line<T>, c: Claim, reported: ClaimOutcome): boolean => {
    if (c.userId === null) return false;
    const known = reported === "booked" || reported === "advisor-busy" || reported === "lost-race";
    const outcome: ClaimOutcome = known ? reported : c.returnable && !c.tried ? "untried" : "unknown";
    // #3489 step 3: an advisor may be free again, so a pending verdict no longer holds.
    // #3529: only an ending that may have left them free (see `Line.epoch`).
    if (outcome === "untried" || outcome === "unknown") line.epoch++;
    const uid = c.userId;
    const f = line.frontier;
    if (outcome === "untried") return f !== null && (f.read.includes(uid) || f.lower.some((r) => r.read.includes(uid)));
    if (f) {
      f.read = f.read.filter((id) => id !== uid);
      for (const r of f.lower) r.read = r.read.filter((id) => id !== uid);
    }
    return false;
  };

  // #3489: who on the frontier nobody in flight has claimed, while it is fresh, as what a
  // released confirm is handed. #3529: across the frontier's rung and every rung below it
  // that the same read found, in ladder order, each advisor once, at the highest rung it
  // is on, so the ladder is handed out top rung first.
  const unclaimedOnFrontier = (line: Line<T>): StartFrom[] => {
    const f = line.frontier;
    if (!f || now() - f.at > FRONTIER_FRESH_MS) return [];
    const taken = new Set<string>();
    for (const c of line.claims.values()) if (c.userId !== null) taken.add(c.userId);
    const out: StartFrom[] = [];
    const rungs = [{ rung: f.rung, read: f.read }, ...f.lower];
    // The deepest rung that brings an advisor no rung above it already lists: pools overlap,
    // and a rung of people already above adds nobody, booked or not.
    let deepest: number | null = null;
    if (f.lowerComplete) {
      const listed = new Set<string>();
      for (const r of rungs) {
        if (r.read.some((id) => !listed.has(id))) deepest = r.rung;
        for (const id of r.read) listed.add(id);
      }
    }
    for (const r of rungs) {
      for (const id of r.read) {
        if (taken.has(id)) continue;
        taken.add(id);
        out.push({ rung: r.rung, advisor: id, read: [...r.read], ...(r.rung === deepest ? { deepest: true as const } : {}) });
      }
    }
    // The final one is the last unclaimed advisor the read holds (`StartFrom.last`).
    if (out.length > 0) out[out.length - 1] = { ...out[out.length - 1]!, last: true };
    return out;
  };
  // #3529: whether the frontier's deepest rung has one below it that no read covers. Only a
  // read that says it covered every rung below (`lowerComplete`, with or without anybody
  // listed) rules that out; lower rungs listed without it may stop short of the ladder's end.
  const frontierBelow = (f: NonNullable<Line<T>["frontier"]>): boolean => (f.lowerComplete ? false : f.below);
  // #3489 step 3: a pending verdict holds everybody waiting only while nothing that could
  // free an advisor has happened since and a claim is still in flight to end it.
  const pendingHolds = (line: Line<T>): boolean =>
    line.pending !== null && line.pending.epoch === line.epoch && line.claims.size > 0;
  // Everybody waiting answered "taken", and the line dropped.
  const refuseAll = (key: string, line: Line<T>, refusal: "race" | "taken", settled: T | null): void => {
    line.pending = null;
    drop(key, line);
    settledLately.set(key, { refusal, settled, at: now() });
    for (const w of line.waiting.splice(0)) w.answer({ kind: "refused", refusal, settled });
  };
  const handedInFlight = (line: Line<T>): number => {
    let n = 0;
    for (const c of line.claims.values()) if (c.handed) n++;
    return n;
  };

  // The one way any path expires leases (#3274 review): expire, and when that
  // released the holder, hand the line on at once. Expiring without handing on
  // left anybody waiting behind nobody until their own wait ran out. Every caller
  // goes through this, so none can forget the second half.
  const expireAndHandOn = (key: string, line: Line<T>): void => {
    if (expire(line)) promoteNext(key, line);
  };

  // The one test for a line nobody needs any more: nobody leading it without
  // having handed on, nobody waiting, no claim in flight, no lookahead out.
  const dropIfIdle = (key: string, line: Line<T>) => {
    expireAndHandOn(key, line);
    if (line.holder === null && line.waiting.length === 0 && line.claims.size === 0 && line.looking === 0) {
      drop(key, line);
    }
  };

  const promoteNext = (key: string, line: Line<T>): void => {
    if (line.holder !== null) return;
    if (line.waiting.length === 0) {
      dropIfIdle(key, line);
      return;
    }
    // #3489: release one waiter per advisor on the frontier nobody has claimed, each
    // handed its advisor (claimed for it here, so two can never be handed one), up to
    // RELEASE_CAP in flight. The one handed the rung's LAST unclaimed advisor holds the
    // line, as any confirm on a rung's last advisor does (#3257). When the cap stops
    // the release, the rest wait for a handed confirm to end.
    const free = unclaimedOnFrontier(line);
    if (free.length > 0) {
      const room = RELEASE_CAP - handedInFlight(line);
      const k = Math.min(free.length, line.waiting.length, Math.max(0, room));
      const below = frontierBelow(line.frontier!);
      for (let i = 0; i < k; i++) {
        const w = line.waiting.shift()!;
        // #3489 step 3: with a rung below, the one handed the rung's last advisor does
        // not hold the line either; the confirms behind it walk on past the rung.
        w.answer(leadTurn(key, line, free[i]!, i === free.length - 1 && !below));
      }
      if (room <= 0) return;
      // Nobody holds the line and the rung is handed out: on a ladder with a rung
      // below, one more confirm walks down past it (step 3); otherwise the rest wait.
      if (k > 0 && !(below && line.holder === null && line.waiting.length > 0 && unclaimedOnFrontier(line).length === 0)) return;
    }
    // #3489 step 3: nothing to read until a claim in flight ends; one that has ended
    // without booking, or none left in flight, discards the verdict and one reads again.
    if (pendingHolds(line)) return;
    line.pending = null;
    line.waiting.shift()!.answer(leadTurn(key, line));
  };

  const leadTurn = (key: string, line: Line<T>, start?: StartFrom, holds = true, spent = false): Extract<QueueTurn<T>, { kind: "lead" }> => {
    const me = {};
    let reported = false;
    // #3489 step 3: the line's epoch when this confirm first met a rung spent by claims,
    // so a park can tell whether everything it walked past has since booked.
    // #3529: a confirm handed a rung inherits the epoch at which the confirm whose read it
    // was handed first read, since that confirm's walk is what stands for the rungs above.
    let spentAt: number | null = start ? (line.frontier?.readAt ?? null) : null;
    // #3529: the line's epoch at this confirm's first read through it, which vouches for
    // a full verdict that holds only `unlessFreed`. A confirm handed a rung inherits the
    // epoch of the read it was handed from, since that read is what saw the rungs above.
    let readAt: number | null = start ? (line.frontier?.readAt ?? null) : null;
    // #3325: a host that requires acknowledgement gives a new lead only the ack
    // window; `ack` and `renew` extend it by a full lease from then.
    let until = now() + (ackMs ?? leaseMs);
    // #3274 review: the lease ends on its own, not only when something next reads the
    // line, so an abandoned turn frees whoever is still waiting then, and a line with
    // nobody left in it is dropped, with no traffic needed. Followers ALREADY behind
    // an abandoned holder usually do not benefit: a follower's own wait (10s,
    // `CONFIRM_QUEUE_WAIT_MS`) is shorter than the lease (14s), so it times out first
    // and is answered retryably. That is accepted: it needs a confirm torn down while
    // holding the line, which is rare, and the answer is one the lead can retry, which
    // is now served by a line that has been freed. Cancelled when the turn reports.
    // A timer can fire a moment before `until` by the clock it is judged against
    // (the two clocks disagree by a millisecond), find nothing expired, and never run
    // again. So it re-arms for whatever is left while this turn is still in flight.
    let cancelLease: () => void = () => {};
    const onLeaseEnd = () => {
      const left = until - now();
      if (left > 0 && line.claims.has(me)) {
        cancelLease = leaseTimer(left, onLeaseEnd);
        return;
      }
      dropIfIdle(key, line);
    };
    cancelLease = leaseTimer(until - now(), onLeaseEnd);
    // A turn whose lease has passed was dropped by `expire`: whatever it does next
    // is ignored, so a late claim cannot exclude an advisor again.
    const live = () => !reported && line.claims.has(me);
    if (holds) line.holder = me;
    line.claims.set(me, { userId: start?.advisor ?? null, until, tried: false, handed: start !== undefined, returnable: start !== undefined });
    const handOn = () => {
      if (line.holder !== me) return;
      line.holder = null;
      promoteNext(key, line);
    };
    const claimedByOthers = (): Set<string> => {
      expireAndHandOn(key, line);
      const others = new Set<string>();
      for (const [who, c] of line.claims) if (who !== me && c.userId !== null) others.add(c.userId);
      return others;
    };
    const claim = (userId: string | null, othersRemain: boolean, returnable = false): void => {
      expireAndHandOn(key, line);
      if (!live()) return;
      const before = line.claims.get(me)!;
      // #3489: the advisor this replaces ended here: tried, it was found busy or lost
      // its race; untried (an older client ignoring what it was handed), it goes back.
      const back = before.userId !== userId && endAdvisor(line, before, "advisor-busy");
      line.claims.set(me, { userId, until, tried: false, handed: before.handed, returnable });
      if (othersRemain) handOn();
      else if (back) promoteNext(key, line);
    };
    // The pending lease timer fires at the old end, finds time left and re-arms for
    // it (`onLeaseEnd`), so extending is only moving `until` on the turn and its claim.
    const renew = (): void => {
      expireAndHandOn(key, line);
      if (!live()) return;
      until = now() + leaseMs;
      const mine = line.claims.get(me);
      if (mine) mine.until = until;
    };
    return {
      kind: "lead",
      ack: renew,
      renew,
      alive: () => {
        expireAndHandOn(key, line);
        return live();
      },
      waiting: () => line.waiting.length,
      ...(start ? { start } : {}),
      ...(spent ? { spent: true as const } : {}),
      seat: {
        claimedByOthers,
        claim,
        claimFirst(candidates, place) {
          const others = claimedByOthers();
          if (readAt === null && live()) readAt = line.epoch;
          const unclaimed = candidates.filter((id) => !others.has(id));
          // #3489 step 3: to a confirm that can walk, a rung every candidate of which is
          // claimed is spent. It claims nothing here and leaves the frontier as it was.
          if (place?.canWalk && candidates.length > 0 && unclaimed.length === 0) {
            if (spentAt === null && live()) spentAt = line.epoch;
            return { pool: [], unclaimed: 0, spent: true, waiting: line.waiting.length };
          }
          const pool = unclaimed.length > 0 ? unclaimed : [...candidates];
          // #3489: a caller that names its rung makes its read the line's frontier, so
          // handing the line on releases one waiter per advisor it left unclaimed.
          if (place && live()) {
            line.frontier = {
              rung: place.rung,
              read: [...candidates],
              at: now(),
              below: place.below === true,
              readAt: readAt ?? line.epoch,
              // #3529: only rungs below this one, sorted and each once (the first listing of a
              // repeated rung kept), since they come over the wire, so the ladder is handed top first.
              lower: (place.lower ?? [])
                .filter((r, i, all) => r.rung > place.rung && all.findIndex((o) => o.rung === r.rung) === i)
                .sort((x, y) => x.rung - y.rung)
                .map((r) => ({ rung: r.rung, read: [...r.read] })),
              lowerComplete: place.lowerComplete === true,
            };
          }
          // A walker on a rung's LAST unclaimed advisor hands on too when there is a rung
          // below, so the confirms behind it walk down at once rather than wait out its
          // whole confirm (step 3).
          const handsOn = unclaimed.length > 1 || (place?.canWalk === true && place.below === true && unclaimed.length === 1);
          // Read before the claim hands on, which takes a waiter off the line.
          const waitingNow = line.waiting.length;
          if (pool.length > 0) claim(pool[0]!, handsOn, place !== undefined);
          return { pool, unclaimed: unclaimed.length, ...(place?.canWalk ? { waiting: waitingNow } : {}) };
        },
        trying(userId) {
          if (!live()) return;
          const mine = line.claims.get(me);
          if (mine && mine.userId === userId) mine.tried = true;
        },
        claimBeside(userId, besides) {
          const others = claimedByOthers();
          claim(userId, besides.some((id) => id !== userId && !others.has(id)));
        },
        pass() {
          claim(null, true);
        },
      },
      done(verdict, outcome, settlement) {
        if (reported) return;
        expireAndHandOn(key, line);
        const mine = line.claims.get(me);
        reported = true;
        cancelLease();
        if (mine) endAdvisor(line, mine, outcome ?? "unknown");
        line.claims.delete(me);
        if (line.holder === me) line.holder = null;
        // #3529: a verdict that holds only while nothing was freed since this confirm read.
        if (verdict.full && (verdict.unlessFreed !== true || (readAt !== null && readAt === line.epoch))) {
          // No other confirm is still booking in the slot: it settles the waiting now.
          if (line.claims.size === 0) {
            refuseAll(key, line, verdict.refusal, verdict.settled);
            return;
          }
          // #3489 step 3: one in flight may yet fail and free its advisor, so the verdict
          // is HELD rather than the next asking for itself (which re-read every rung while
          // the only thing that could change the answer was that claim).
          line.pending = { refusal: verdict.refusal, epoch: line.epoch };
          promoteNext(key, line);
          return;
        }
        // #3489 step 3: the last claim in flight booked, and nothing freed an advisor
        // since the verdict was held: it applies, answered with the settlement read now.
        // With none, the line never answers from a stale one: one confirm reads instead.
        const p = line.pending;
        if (outcome === "booked" && p !== null && p.epoch === line.epoch && line.claims.size === 0 && settlement !== undefined) {
          refuseAll(key, line, p.refusal, settlement);
          return;
        }
        promoteNext(key, line);
      },
      park(ownWaitMs) {
        return this.parkNow(ownWaitMs).turn;
      },
      parkNow(ownWaitMs) {
        if (reported) return { kind: "wait", turn: Promise.resolve({ kind: "unqueued" as const }), cancel() {} };
        expireAndHandOn(key, line);
        const mine = line.claims.get(me);
        reported = true;
        cancelLease();
        // An advisor it still holds was asked about and found busy on its way down, or
        // was never asked (the line decides untried or unknown).
        if (mine) endAdvisor(line, mine, mine.tried ? "advisor-busy" : "unknown");
        line.claims.delete(me);
        if (line.holder === me) line.holder = null;
        // Every claim it walked past has ended, and all of them booked: nothing has freed
        // an advisor since it met the first (the epoch has not moved, its own claim's end
        // included). Its walk stands, so it leads again at once, ahead of anybody waiting,
        // to report the ladder full (`spent`).
        if (spentAt !== null && spentAt === line.epoch && line.claims.size === 0) {
          line.pending = null;
          const again = leadTurn(key, line, undefined, true, true);
          // #3529: already a lead holding the line, so a caller gone ends it as settling
          // nothing, as cancelling any answered lead does (`waitIn`), and the line moves on.
          return { kind: "wait", turn: Promise.resolve(again), cancel: () => again.done({ full: false }) };
        }
        if (line.pending === null || line.pending.epoch !== line.epoch) line.pending = { refusal: "race", epoch: line.epoch };
        const parked = waitIn(key, line, ownWaitMs);
        promoteNext(key, line);
        return parked;
      },
    };
  };

  // A waiter in `line`: answered with its turn, or `unqueued` when its wait runs out
  // first. The one way a confirm waits, whether it arrived or parked (#3489 step 3).
  const waitIn = (key: string, line: Line<T>, ownWaitMs?: number): Extract<EnteredNow<T>, { kind: "wait" }> => {
    let settled = false;
    let answered: QueueTurn<T> | null = null;
    let resolve: (turn: QueueTurn<T>) => void = () => {};
    const turn = new Promise<QueueTurn<T>>((r) => (resolve = r));
    const leave = () => {
      const i = line.waiting.indexOf(waiter);
      if (i >= 0) line.waiting.splice(i, 1);
      dropIfIdle(key, line);
    };
    const waiter: Waiter<T> = {
      answer(t) {
        if (settled) return;
        settled = true;
        cancelWait();
        answered = t;
        resolve(t);
      },
    };
    const cancelWait = timer(ownWaitMs ?? waitMs, () => {
      if (settled) return;
      settled = true;
      leave();
      resolve({ kind: "unqueued" });
    });
    line.waiting.push(waiter);
    return {
      kind: "wait",
      turn,
      cancel() {
        if (!settled) {
          settled = true;
          cancelWait();
          leave();
          resolve({ kind: "unqueued" });
          return;
        }
        const got = answered as QueueTurn<T> | null;
        if (got?.kind === "lead") got.done({ full: false });
      },
    };
  };

  const enterNow = (key: string, ownWaitMs?: number): EnteredNow<T> => {
    let existing = lines.get(key);
    // #3274: an abandoned leader past its lease no longer holds the line. Handing
    // on serves whoever was already waiting first, in order, before this arrival,
    // and a line left with nobody in it is dropped, so this arrival opens a new one.
    if (existing) {
      expireAndHandOn(key, existing);
      existing = lines.get(key);
    }
    if (!existing) {
      // #3570: the slot was settled full a moment ago; answered as the crowd was.
      const remembered = rememberedFor(key);
      if (remembered) return { kind: "wait", turn: Promise.resolve({ kind: "refused", ...remembered }), cancel() {} };
      const line: Line<T> = { waiting: [], holder: null, claims: new Map(), looking: 0, frontier: null, epoch: 0, pending: null };
      lines.set(key, line);
      return { kind: "lead", turn: leadTurn(key, line) };
    }
    // Every leader in flight has handed on: nobody to wait behind. Unless a pending
    // verdict holds (#3489 step 3): then it would only find the ladder spent too.
    if (existing.holder === null && existing.waiting.length === 0 && !pendingHolds(existing)) {
      // #3489: an advisor the frontier still has unclaimed is handed to it too.
      const free = handedInFlight(existing) < RELEASE_CAP ? unclaimedOnFrontier(existing) : [];
      const f = existing.frontier;
      const start = free.length > 0 && f ? free[0] : undefined;
      return { kind: "lead", turn: leadTurn(key, existing, start, start === undefined || (free.length === 1 && !(f ? frontierBelow(f) : false))) };
    }
    return waitIn(key, existing, ownWaitMs);
  };

  return {
    enter(key, ownWaitMs) {
      const entered = enterNow(key, ownWaitMs);
      return entered.kind === "lead" ? Promise.resolve(entered.turn) : entered.turn;
    },
    enterNow,
    lookahead(key) {
      const found = lines.get(key);
      if (found) expireAndHandOn(key, found);
      const line = lines.get(key);
      // An idle line, or one whose leaders have all handed on: entering leads at
      // once, so there is nothing to look ahead of.
      if (!line || (line.holder === null && line.waiting.length === 0 && !pendingHolds(line))) return null;
      if (line.looking >= CONFIRM_LINE_LOOKAHEAD) return null;
      line.looking++;
      let returned = false;
      // #3325: in a shared object the give back is a network call that can be lost,
      // and a place never returned would keep the line from ever being dropped and,
      // two lost, switch lookahead off for that slot. So the place is leased.
      const giveBack = () => {
        if (returned) return;
        returned = true;
        cancelLookLease();
        line.looking--;
        dropIfIdle(key, line);
      };
      const cancelLookLease = leaseTimer(lookaheadLeaseMs, giveBack);
      return giveBack;
    },
  };
}

/**
 * Which line a confirm joins, in two parts (#3325): the GROUP whose confirms can
 * settle each other (one fallback ladder, one code, or one named advisor's link) and
 * the INSTANT within it. A line shared across isolates is one object per group with a
 * line per instant inside it, because a new object costs about 170ms to create and an
 * existing one about 13ms to call (measured, #3325), and an object per instant would
 * create one on almost every booking.
 */
export interface LineKey {
  /** `ladder:<fingerprint>`, `code:<code>` or `link:<userId>`. */
  group: string;
  /** The instant's epoch milliseconds, as a string. */
  instant: string;
}

/** The one string a per isolate line keys a `LineKey` by. */
export function isolateKeyOf(key: LineKey): string {
  return `${key.group}|${key.instant}`;
}

/** `LineSeat`, answered over the network (#3325). Same rules, every step awaited. */
export interface SharedSeat {
  claimedByOthers(): Promise<ReadonlySet<string>>;
  claim(userId: string, othersRemain: boolean): Promise<void>;
  claimFirst(candidates: readonly string[], place?: ClaimPlace): Promise<ClaimFirstAnswer>;
  /** #3489: see `LineSeat.trying`. */
  trying(userId: string): Promise<void>;
  claimBeside(userId: string, besides: readonly string[]): Promise<void>;
  pass(): Promise<void>;
}

/** `QueueTurn` as the confirm path holds it (#3325). */
export type LineTurn<T> =
  | {
      kind: "lead";
      seat: SharedSeat;
      waiting(): Promise<number>;
      /** Reports the verdict and how this confirm's claim ended (#3489, `ClaimOutcome`),
       *  with the settlement read as it ends (step 3, see `QueueTurn`). */
      done(verdict: LeaderVerdict<T>, outcome?: ClaimOutcome, settlement?: T): Promise<void>;
      /** #3489 step 3: see `QueueTurn.park`. */
      park(waitMs?: number): Promise<LineTurn<T>>;
      /** #3489: what the line handed this confirm when it released it (`StartFrom`). */
      start?: StartFrom;
      /** #3489 step 3: its walk stands; see `QueueTurn` `spent`. */
      spent?: true;
      /**
       * #3338: whether this confirm WAITED behind another for its turn, rather than
       * leading at once or being handed the line at once. A confirm that waited and
       * then drops a tier dropped behind what the ones ahead of it booked, which is
       * counted apart on /admin/routing (`tier-drop-counts.ts`). Only the line knows.
       */
      queued: boolean;
    }
  | { kind: "refused"; refusal: "race" | "taken"; settled: T | null }
  | { kind: "unqueued" };

/**
 * The line as the confirm path uses it (#3325), whether it lives in this isolate or
 * in a shared object. The confirm path awaits every call, so a line answered over the
 * network and one answered from memory are interchangeable behind it.
 */
export interface ConfirmLine<T> {
  enter(key: LineKey, waitMs?: number): Promise<LineTurn<T>>;
  /**
   * As `ConfirmQueue.lookahead`; the give back is awaited too. `waitMs` is the wait
   * the `enter` that follows will ask for: a shared line answers an idle or full line
   * here with the lead or the ticket that `enter` then uses, saving a call.
   */
  lookahead(key: LineKey, waitMs?: number): Promise<(() => Promise<void>) | null>;
  /**
   * Gives back anything a `lookahead` kept for an `enter` that never came (#3351), so a
   * confirm that ends between the two leaves nothing held. A no op when the `enter`
   * came, and on a line that keeps nothing between the two.
   */
  release(): Promise<void>;
}

/** A lead turn from the in memory rules, as the confirm path holds it. `queued`
 *  says whether it came after waiting (#3338). */
export function asLineTurn<T>(turn: QueueTurn<T>, queued: boolean): LineTurn<T> {
  if (turn.kind !== "lead") return turn;
  const seat = turn.seat;
  return {
    kind: "lead",
    queued,
    waiting: async () => turn.waiting(),
    done: async (verdict, outcome, settlement) => turn.done(verdict, outcome, settlement),
    park: async (waitMs) => asLineTurn(await turn.park(waitMs), true),
    ...(turn.start ? { start: turn.start } : {}),
    ...(turn.spent ? { spent: true as const } : {}),
    seat: {
      claimedByOthers: async () => seat.claimedByOthers(),
      claim: async (userId, othersRemain) => seat.claim(userId, othersRemain),
      claimFirst: async (candidates, place) => seat.claimFirst(candidates, place),
      trying: async (userId) => seat.trying(userId),
      claimBeside: async (userId, besides) => seat.claimBeside(userId, besides),
      pass: async () => seat.pass(),
    },
  };
}

/**
 * The per isolate line behind the async interface (#3325). It translates and
 * decides nothing: every rule stays in `makeConfirmQueue`.
 */
export function isolateLine<T>(host: ConfirmQueue<T>): ConfirmLine<T> {
  return {
    async enter(key, waitMs) {
      // #3338: entered at once or after waiting, which only this answer can tell.
      const entered = host.enterNow(isolateKeyOf(key), waitMs);
      return entered.kind === "lead" ? asLineTurn(entered.turn, false) : asLineTurn(await entered.turn, true);
    },
    async lookahead(key) {
      const giveBack = host.lookahead(isolateKeyOf(key));
      return giveBack ? async () => giveBack() : null;
    },
    // The isolate's line keeps nothing between a lookahead and an enter.
    async release() {},
  };
}

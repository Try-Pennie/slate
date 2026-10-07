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
}

/**
 * What a released confirm is handed (#3489): the rung, the advisor claimed for it, and
 * the leader's whole read of that rung in round robin order, which the confirm reasons
 * over (its full verdict, its lost race) instead of a list of one.
 */
export interface StartFrom {
  rung: number;
  advisor: string;
  read: readonly string[];
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
  return { rung, advisor, read: read as string[] };
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
  /** Nothing that settles the slot for anybody else: the next in line leads. */
  | { full: false }
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
  claimFirst(candidates: readonly string[], place?: ClaimPlace): { pool: string[]; unclaimed: number };
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
       */
      done(verdict: LeaderVerdict<T>, outcome?: ClaimOutcome): void;
      waiting(): number;
      seat: LineSeat;
      /**
       * #3489: set when the line RELEASED this confirm on a leader's read: the rung,
       * the advisor claimed for it, and the leader's whole read of that rung. Absent
       * for a confirm that leads and reads for itself.
       */
      start?: StartFrom;
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
  frontier: { rung: number; read: string[]; at: number } | null;
  /** Cheap reads in flight ahead of joining this line (`lookahead`). */
  looking: number;
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
  } = {},
): ConfirmQueue<T> {
  const waitMs = opts.waitMs ?? CONFIRM_QUEUE_WAIT_MS;
  const timer = opts.timer ?? realTimer;
  const now = opts.now ?? (() => Date.now());
  const leaseTimer = opts.leaseTimer ?? unreferencedTimer;
  const leaseMs = opts.leaseMs ?? CONFIRM_CLAIM_LEASE_MS;
  const ackMs = opts.ackMs;
  const lookaheadLeaseMs = opts.lookaheadLeaseMs ?? CONFIRM_CLAIM_LEASE_MS;
  // A key is present while somebody leads it or waits in it.
  const lines = new Map<string, Line<T>>();
  // Removes THIS line only: a lookahead returned after its line settled must not
  // delete a newer line that has since been opened under the same key.
  const drop = (key: string, line: Line<T>) => {
    if (lines.get(key) === line) lines.delete(key);
  };
  // #3274: drop every leader whose lease has passed, as if it had reported nothing
  // that settles the slot. Run before anything reads the claims or the holder, so an
  // abandoned confirm can never be counted as booking an advisor or holding the line.
  // Returns whether the holder was among them, so the caller can hand the line on.
  const expire = (line: Line<T>): boolean => {
    const t = now();
    let freed = false;
    for (const [who, c] of line.claims) {
      if (c.until > t) continue;
      // #3489: an expired claim said nothing about how it ended.
      if (endAdvisor(line, c, "unknown")) freed = true;
      line.claims.delete(who);
      if (line.holder === who) {
        line.holder = null;
        freed = true;
      }
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
    if (outcome === "untried") return line.frontier !== null && line.frontier.read.includes(c.userId);
    if (line.frontier) line.frontier.read = line.frontier.read.filter((id) => id !== c.userId);
    return false;
  };

  // #3489: who on the frontier nobody in flight has claimed, while it is fresh.
  const unclaimedOnFrontier = (line: Line<T>): string[] => {
    const f = line.frontier;
    if (!f || now() - f.at > FRONTIER_FRESH_MS) return [];
    const claimed = new Set<string>();
    for (const c of line.claims.values()) if (c.userId !== null) claimed.add(c.userId);
    return f.read.filter((id) => !claimed.has(id));
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
      const { rung, read } = line.frontier!;
      for (let i = 0; i < k; i++) {
        const w = line.waiting.shift()!;
        w.answer(leadTurn(key, line, { rung, advisor: free[i]!, read: [...read] }, i === free.length - 1));
      }
      if (k > 0 || room <= 0) return;
    }
    line.waiting.shift()!.answer(leadTurn(key, line));
  };

  const leadTurn = (key: string, line: Line<T>, start?: StartFrom, holds = true): Extract<QueueTurn<T>, { kind: "lead" }> => {
    const me = {};
    let reported = false;
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
      seat: {
        claimedByOthers,
        claim,
        claimFirst(candidates, place) {
          const others = claimedByOthers();
          const unclaimed = candidates.filter((id) => !others.has(id));
          const pool = unclaimed.length > 0 ? unclaimed : [...candidates];
          // #3489: a caller that names its rung makes its read the line's frontier, so
          // handing the line on releases one waiter per advisor it left unclaimed.
          if (place && live()) line.frontier = { rung: place.rung, read: [...candidates], at: now() };
          if (pool.length > 0) claim(pool[0]!, unclaimed.length > 1, place !== undefined);
          return { pool, unclaimed: unclaimed.length };
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
      done(verdict, outcome) {
        if (reported) return;
        expireAndHandOn(key, line);
        const mine = line.claims.get(me);
        reported = true;
        cancelLease();
        if (mine) endAdvisor(line, mine, outcome ?? "unknown");
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
      const line: Line<T> = { waiting: [], holder: null, claims: new Map(), looking: 0, frontier: null };
      lines.set(key, line);
      return { kind: "lead", turn: leadTurn(key, line) };
    }
    // Every leader in flight has handed on: nobody to wait behind.
    if (existing.holder === null && existing.waiting.length === 0) {
      // #3489: an advisor the frontier still has unclaimed is handed to it too.
      const free = handedInFlight(existing) < RELEASE_CAP ? unclaimedOnFrontier(existing) : [];
      const f = existing.frontier;
      const start = free.length > 0 && f ? { rung: f.rung, advisor: free[0]!, read: [...f.read] } : undefined;
      return { kind: "lead", turn: leadTurn(key, existing, start, start === undefined || free.length === 1) };
    }
    const line = existing;
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
      if (!line || (line.holder === null && line.waiting.length === 0)) return null;
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
  claimFirst(candidates: readonly string[], place?: ClaimPlace): Promise<{ pool: string[]; unclaimed: number }>;
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
      /** Reports the verdict and how this confirm's claim ended (#3489, `ClaimOutcome`). */
      done(verdict: LeaderVerdict<T>, outcome?: ClaimOutcome): Promise<void>;
      /** #3489: what the line handed this confirm when it released it (`StartFrom`). */
      start?: StartFrom;
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
    done: async (verdict, outcome) => turn.done(verdict, outcome),
    ...(turn.start ? { start: turn.start } : {}),
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

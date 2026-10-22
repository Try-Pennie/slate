// Many confirms for one agent's slot at once (#3221).
//
// The 2026-10-04 load run (37215457763) sent 100 confirms for one slot in a pool
// of one agent within 82ms. All 100 came back 503 after 14.1 to 15.6 seconds and
// nobody was booked, where the 2026-09-15 pass had one winner and 99 SLOT_TAKEN.
//
// What they were waiting on, measured rather than assumed:
//
//  - Nothing on the create path takes a lock. The only place two confirms for one
//    slot meet is the bookings table's unique and overlap indexes at the INSERT,
//    the last write, after the reservation and the Google event.
//  - So each confirm ran the whole path on its own, and the only thing the hundred
//    shared was CAPACITY. The burst's finish times say which kind of wait it was:
//    a queue on a lock answers in arrival order, spread across the queue, and lets
//    the head through. Here every request ended between 14.1 and 15.6 seconds, in
//    no relation to the order they were sent, and the head did not get through.
//    That is a shared resource handing each of the hundred a hundredth of itself
//    until the 12 second budget ran out on all of them at once.
//  - The size of it: in the same run, the three confirms that lost a race on their
//    own (status 409) each cost the isolate 198, 259 and 292ms of CPU over a path
//    of about twenty dependency calls, so a hundred of them on one isolate are about
//    25 seconds of work against a 12 second budget.
//
// The simulation below reproduces that from the real orchestration: every
// dependency call is one unit of a shared resource (12ms each, the measured
// ~250ms over ~20 calls), the bookings unique index refuses the second insert for
// a slot, and every call honours the real call budget. The CONTROL runs the burst
// with the queue switched off and must reproduce the incident exactly: nobody
// booked, all 100 answered 503 at the budget, each stopped mid path with most of
// its time spent queued. Then the fix runs the same burst and the first confirm
// must win while every other one is told SLOT_TAKEN well inside the budget.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-contention.ts
import { refusalTraceOf } from "../src/lib/booking/refusal-trace.ts";
import { tierLadder } from "../src/lib/routing/tiers.ts";
import {
  bookViaApi,
  createBooking,
  timeoutAsRetryable,
  DependencyTimeoutError,
  SlotUnavailableError,
  RaceLostRefusalError,
  ExistingCallError,
  NoEligibleAgentsError,
  confirmQueueKey,
  queueKeyBeforeRouting,
  stableKeyFor,
  type BookingDeps,
  type CreateBookingInput,
  type BookingResult,
} from "../src/lib/booking/orchestration.ts";
import { withinBookingConfirmBudget, BOOKING_CONFIRM_BUDGET_MS } from "../src/lib/booking/confirm-budget.ts";
import { makeConfirmQueue, isolateLine, CONFIRM_QUEUE_WAIT_MS, CONFIRM_LINE_LOOKAHEAD, CONFIRM_LINE_SETTLED_MEMORY_MS, type ConfirmLine, type LineTurn } from "../src/lib/booking/confirm-queue.ts";
import type { Booking, BookingReservation, User } from "../src/lib/db/types.ts";
import type { BookingContext } from "../src/lib/booking/orchestration.ts";
import type { LadderInputs } from "../src/lib/availability/ladder-inputs.ts";
import { createAsserter, makeDeps, makeBooking, input, users, bucket as fakeBucket, eventType as fakeEventType } from "./lib/booking-fakes.ts";
import { VirtualClock, SharedResource, onSharedCapacity, occupy, objectOnClock, type CallRecord, type CallCost } from "./lib/confirm-contention-sim.ts";
import {
  classifyDeps,
  ON_DATABASE,
  OFF_DATABASE,
  databaseCosts,
  LOAD_MODEL_ADVISORS,
  LOAD_RUN_PROFILE,
  PRODUCTION_PROFILE,
  STACK_LOAD_RUN_PROFILE,
  STACK_PRODUCTION_PROFILE,
  RUN_37640583621,
  ladder500,
  type Arrival,
  type BurstRung,
  type BurstShape,
  type LoadProfile,
} from "./lib/confirm-load-model.ts";
import { makeConfirmLineHost, makeConfirmLineObject, CONFIRM_LINE_PROTOCOL, CONFIRM_LINE_OLDEST_PROTOCOL } from "../src/lib/booking/confirm-line-object.ts";
import { BURST_LOSER_LAG_MS } from "./loadtest/judge-booking-run.ts";
import { makeSharedConfirmLine } from "../src/lib/booking/shared-confirm-line.ts";
import { CONFIRM_CROWD_RULE, type ConfirmCrowdRule } from "../src/lib/confirm-crowd-rule.ts";
import { makeCommitCostLog } from "../src/lib/booking/commit-cost.ts";
import { ladderGroupOf } from "../src/lib/booking/line-key.ts";
import { groupingEntriesOf, groupingPutMessage, groupingSnapshotOf, type GroupingSnapshot } from "../src/lib/booking/pool-grouping.ts";
import {
  POOL_GROUPING_FETCH_MS,
  POOL_GROUPING_FRESH_MS,
  POOL_GROUPING_RETRY_MS,
  POOL_GROUPING_REFRESH_AHEAD_MS,
  makeGroupingReader,
  makeGroupingStore,
} from "../src/lib/booking/pool-grouping-reader.ts";
import { groupByPool } from "../src/lib/availability/pool-key.ts";
import { poolGroupingRoster } from "./lib/pool-grouping-fixture.ts";
import { memoryGroupingStorage } from "./lib/memory-grouping-storage.ts";

const { assert, finish } = createAsserter();

/** #3257: a pool of twenty, the size of a popular bucket. */
const BIG_POOL = Array.from({ length: 20 }, (_, i) => `p${i}`);
for (const id of [...BIG_POOL, ...LOAD_MODEL_ADVISORS]) (users as Record<string, User>)[id] = { id, name: `Agent ${id}`, email: `${id}@x.com` } as unknown as User;

/** One isolate's share: one unit of work at a time, 12ms each (see the header). */
const CAPACITY = 1;
const SERVICE_MS = 12;
const BURST = 100;
/** #3489: how long a background lane keeps the database busy in a modelled burst: past
 *  the last arrival (1.8s) plus a whole budget and its cleanup allowance (14s). */
const BACKGROUND_UNTIL_MS = 20_000;
/** Not I/O, so they stay synchronous in the wrapped deps. */
const SYNCHRONOUS = new Set(["newManageToken", "newIdempotencyKey", "newBookingId", "pageRaceBoundHit", "deferSend", "deadlineTimer", "appBaseUrl", "lineGroupOf"]);

type Outcome = "created" | "SLOT_TAKEN" | "503" | string;
interface Run {
  outcome?: Outcome;
  answeredMs?: number;
  result?: BookingResult;
  error?: unknown;
  calls: CallRecord[];
  /** #3460: the line group this confirm keyed on, when it asked for one. */
  group?: string;
}

/** #3460: what one isolate holds of the pool grouping when the burst arrives. */
type GroupingState = "warm" | "cold" | "stale";

/** A queue that never queues: the behaviour before #3221, for the control. Every
 *  confirm leads at once with nobody behind it, so each runs the whole path. */
const NO_QUEUE: ConfirmLine<never> = {
  enter: async () => ({
    kind: "lead",
    done: async () => {},
    waiting: async () => 0,
    seat: {
      claimedByOthers: async () => new Set<string>(),
      claim: async () => {},
      claimFirst: async (candidates) => ({ pool: [...candidates], unclaimed: candidates.length }),
      claimBeside: async () => {},
      trying: async () => {},
      pass: async () => {},
    },
  }),
  lookahead: async () => null,
  release: async () => {},
};

/**
 * #3338: the code the crowds below confirm into, unless a case names its own. Its
 * tier ladder is ONE rung, so the pool a case gives is the whole ladder, and "the
 * last advisor of the pool" is the last of the ladder, where a leader that books
 * it settles everybody waiting (`createHeld`). The shared fixture's 411 has three
 * rungs; a crowd there drops down them, which the #3338 cases at the end drive on
 * purpose with a pool for each rung.
 */
const ONE_RUNG = "110";

function lead(i: number, over: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    ...input,
    bucketCode: ONE_RUNG,
    externalId: `burst-${i}`,
    salesforceId: `sf-${i}`,
    attendee: { name: `Lead ${i}`, email: `lead${i}@example.com`, phone: `+1203555${String(1000 + i)}` },
    ...over,
  };
}

/** The line object as a burst reaches it: one JSON message in, one JSON answer out (#3560). */
type ObjectHost = { handle(message: unknown): Promise<string> };
type ObjectHostFactory = (deps: Parameters<typeof makeConfirmLineHost>[0]) => ObjectHost;

/**
 * Runs `inputs` at the same instant against one shared database and one shared
 * capacity, and returns how each was answered. The pool is `pool`, and the
 * candidate read leaves out anybody already booked at the time, as the real one
 * does through the busy block the confirm writes before it answers.
 */
async function burst(opts: {
  inputs: CreateBookingInput[];
  pool: string[];
  /**
   * #3338: a pool for each rung of the requested code's tier ladder, read by the
   * code the confirm asks about, so a confirm that drops a rung books from that
   * rung's advisors. A code absent here has no bucket row, so the ladder skips it,
   * as it does a lower tier nobody created. Unset, every code reads `pool`.
   */
  poolByCode?: Record<string, string[]>;
  queue: "real" | "off";
  /**
   * #3325: spread the confirms over this many isolates, confirm i on isolate
   * i % isolates, all sharing the one database. `line: "isolate"` gives each its
   * own line (what production ran on 2026-10-05); `line: "shared"` gives every
   * isolate the shared line's client, talking to ONE object host on this clock.
   */
  isolates?: { count: number; line: "isolate" | "shared" };
  viaApi?: boolean;
  /** #3257: how long one dependency call takes on the shared capacity. */
  serviceMs?: number;
  /** #3257: the FIRST person read fails, as a leader meeting an outage would. */
  failFirstPersonRead?: boolean;
  /** #3257: bookings that already exist before the burst (a lead holding the time). */
  held?: Booking[];
  /** Bookings another isolate has just made, which the candidate read (the busy
   *  block cache) has not caught up with yet, so only the insert sees them. */
  heldElsewhere?: Booking[];
  /** #3257: the FIRST read of who already sits at the instant fails. */
  failFirstSeatedRead?: boolean;
  /** #3257: how long Google takes to say whether an advisor is free. The slow
   *  scenarios use 3s, the assumed split of the 7.4 to 8.0s a production confirm
   *  took on 2026-10-04 (#3221); measured 2026-10-22 it is 215ms at the median and
   *  468ms at the p95 (#3490, `MEASURED_PRODUCTION_GOOGLE_DELAY`). */
  slowGoogleMs?: number;
  /** How long Google takes to write the advisor's calendar event, the other slow
   *  part, which runs after the advisor is chosen. */
  slowEventMs?: number;
  /** When each confirm arrives, from the first; absent means all at once. */
  arriveAtMs?: number[];
  /** #3529: advisors Google reports busy at the time, though nothing in Slate holds it. */
  busyAtGoogle?: string[];
  /**
   * #3529: WAITING, not capacity, on a confirm's own reads before its line work (the
   * person read, the replay and in flight lookups), as a crowd met them in the load runs
   * (400 to 550ms a call). What a walker's way to the next rung costs, without slowing
   * every other call on the shared capacity.
   */
  slowReadsMs?: number;
  /** The FIRST calendar write for this advisor's email fails at once, an outage
   *  that ends that confirm and frees the advisor it claimed. */
  failFirstEventFor?: string;
  /** The booking a reschedule loads by its token, for a lead moving their call. */
  existingContext?: BookingContext;
  /** How long Google takes on a reschedule: the live busy read and the event move. */
  slowRescheduleMs?: number;
  /** The FIRST idempotency read for this key fails (a lookahead meeting an outage). */
  failFirstIdempotencyReadOf?: string;
  /**
   * #3440: reservations an earlier request wrote and never finished (a crash mid
   * create), each found only by its OWN idempotency key, so the confirm re-submitted
   * with that key resumes it and nobody else does.
   */
  inFlight?: BookingReservation[];
  /** #3462: how long a reservation's delete takes, the last step of a lost
   *  attempt's rollback. Kept inside the 2s cleanup allowance it runs under. */
  slowCleanupMs?: number;
  /**
   * #3460: the pool grouping each isolate holds when the burst arrives (isolate k takes
   * `states[k % states.length]`), what the directory holds, and whether each confirm
   * fetches it before its line key. `warm` is a local read a second old, `stale` one
   * seventy seconds old, `cold` nothing. `fetch: false` is main before #3460: a confirm
   * keys on what its isolate already holds.
   */
  grouping?: {
    states: readonly GroupingState[];
    snapshot: GroupingSnapshot | null;
    fetch: boolean;
  };
  /**
   * #3489: the calibrated load model (`scripts/lib/confirm-load-model.ts`) in place of
   * the one unit of capacity every call costs otherwise. The database is the profile's
   * slots, each call its measured latency; the shared line's object is reached with a
   * round trip and answers nothing until it is up; and confirm i arrives at
   * `arrivals[i]`: its budget starts at the route's start, it reaches the line after
   * the route's checks, and it reads the switch when the run says it did. What each
   * request does on the database AFTER it answered is queued there too. Google's time is
   * still `slowGoogleMs` / `slowEventMs`, which the profile sets.
   */
  /**
   * #3489 step 3: reach the line as a client from before #3489 would, naming no rung on
   * `claimFirst` (so no frontier, no release and no walking past claims), which every line
   * still serves with the rules from before (protocol 1, its fields optional). What the
   * calibration replays run 37640583621 with: that run's line had none of them.
   */
  olderClient?: boolean;
  /**
   * #3560: the object every line group is hosted by, in place of the current one: an
   * object from an older build, as a line Worker rolled back alone would serve.
   */
  objectHost?: ObjectHostFactory;
  /**
   * #3489: the confirms read their whole ladder's candidate inputs in one request
   * (`BookingDeps.readLadderInputs`), as the stack does; the run's code never did, so
   * the calibration leaves it off.
   */
  ladderRead?: boolean;
  model?: {
    profile: LoadProfile;
    arrivals: readonly Arrival[];
    firstAnswerMs: number;
    /** Other work on the database through the burst (the run's own sync lane): this
     *  many callers, each running one statement after another. */
    backgroundCallers?: number;
  };
}) {
  const clock = new VirtualClock(Date.parse("2026-06-01T00:00:00.000Z"));
  const burstStart = clock.now;
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    const model = opts.model;
    const resource = model
      ? new SharedResource(clock, model.profile.database.slots, model.profile.database.statementMs)
      : new SharedResource(clock, CAPACITY, opts.serviceMs ?? SERVICE_MS);
    const everyone = opts.poolByCode ? [...new Set(Object.values(opts.poolByCode).flat())] : opts.pool;
    const poolFor = (code: string): string[] => (opts.poolByCode ? (opts.poolByCode[code] ?? []) : opts.pool);
    const { deps: base, calls } = makeDeps({
      candidates: opts.pool,
      freeEmails: new Set(everyone.filter((id) => !(opts.busyAtGoogle ?? []).includes(id)).map((id) => users[id].email)),
      existing: opts.existingContext,
    });
    // The bookings table: the active unique index on (agent, start), and the one
    // on the idempotency key a double submit collapses onto.
    const bySlot = new Map<string, Booking>();
    const byKey = new Map<string, Booking>();
    for (const b of opts.held ?? []) {
      bySlot.set(`${b.assigned_user_id}|${b.starts_at}`, b);
      if (b.idempotency_key) byKey.set(b.idempotency_key, b);
    }
    const unseen = new Set<string>();
    for (const b of opts.heldElsewhere ?? []) {
      bySlot.set(`${b.assigned_user_id}|${b.starts_at}`, b);
      unseen.add(`${b.assigned_user_id}|${b.starts_at}`);
    }
    const seatedReads: string[] = [];
    let raceLosses = 0;
    let eventFailed = false;
    let idempotencyFailed = false;
    const queue: ConfirmLine<unknown> =
      opts.queue === "off"
        ? NO_QUEUE
        : isolateLine(makeConfirmQueue({
            timer: (ms, fire) => clock.at(clock.now + ms, fire),
            // #3274: the lease end runs on the same virtual clock, so the simulation
            // owns every timer the line sets and judges leases by its own time.
            leaseTimer: (ms, fire) => clock.at(clock.now + ms, fire),
            now: () => clock.now,
          }));
    const timerOnClock = (ms: number, fire: () => void) => clock.at(clock.now + ms, fire);
    const isolateLines: ConfirmLine<unknown>[] = [];
    const asReached = (line: ConfirmLine<unknown>): ConfirmLine<unknown> => (opts.olderClient ? asOlderClient(line) : line);
    const isolateCosts = Array.from({ length: opts.isolates?.count ?? 0 }, () => makeCommitCostLog());
    if (opts.isolates) {
      let ids = 0;
      // One object per line GROUP, as production names them (#3460): a crowd split across
      // `ladder:` and `code:` groups meets several objects, each electing its own leader,
      // which one object shared by every group would hide.
      const hosts = new Map<string, ObjectHost>();
      const hostFor = (group: string) => {
        let host = hosts.get(group);
        if (!host) {
          host = (opts.objectHost ?? makeConfirmLineHost)({ now: () => clock.now, timer: timerOnClock, leaseTimer: timerOnClock, newId: () => `o${++ids}` });
          hosts.set(group, host);
        }
        return host;
      };
      // #3489: under the load model each group's object is reached across the network,
      // and starts on its first message.
      const reached = new Map<string, (m: Record<string, unknown>) => Promise<Record<string, unknown>>>();
      const sendTo = (group: string) => {
        let send = reached.get(group);
        if (!send) {
          send = model
            ? objectOnClock(clock, { roundTripMs: model.profile.line.roundTripMs, firstAnswerMs: model.firstAnswerMs }, (m) => hostFor(group).handle(m))
            : async (m) => JSON.parse(await hostFor(group).handle(m)) as Record<string, unknown>;
          reached.set(group, send);
        }
        return send;
      };
      for (let k = 0; k < opts.isolates.count; k++) {
        const own = isolateLine(makeConfirmQueue({ timer: timerOnClock, leaseTimer: timerOnClock, now: () => clock.now }));
        isolateLines.push(asReached(
          opts.isolates.line === "isolate"
            ? own
            : makeSharedConfirmLine<unknown>({
                // Without the load model the object is reached in no time at all, so
                // network latency is the load run's to measure (#3325); with it
                // (#3489) the object is reached through `objectOnClock`, a round trip
                // on every message and a first answer once the object is up.
                // #3560: an older client asks for the protocol it was built with, as well as
                // leaving out the fields it never knew.
                namespace: { stubFor: (group) => ({ send: opts.olderClient ? (m) => sendTo(group)({ ...m, v: CONFIRM_LINE_OLDEST_PROTOCOL }) : sendTo(group) }) },
                fallback: own,
                enabled: async () => ({ on: true, source: "read" }),
                record: () => {},
                onReachFailure: () => {},
                now: () => clock.now,
                timer: timerOnClock,
                newId: () => `c${++ids}`,
                // #3355 item 4: a give back runs on the simulation's clock with nothing to
                // outlive; it never rejects, so it is left to finish.
                keepAlive: () => {},
              }),
        ));
      }
    }
    // #3460: each isolate's own pool grouping, the directory every isolate reaches as
    // one instance (the real object, through JSON both ways), and each isolate's reader.
    const groupings: { lineGroupOf: (code: string) => string | null; ensure: (() => Promise<unknown>) | null }[] = [];
    if (opts.grouping && opts.isolates) {
      const entries = groupingEntriesOf(groupByPool(poolGroupingRoster()));
      const directory = makeConfirmLineObject({ now: () => clock.now, timer: timerOnClock, leaseTimer: timerOnClock, newId: () => "dir", directoryStorage: memoryGroupingStorage() });
      const ask = async (m: Record<string, unknown>) => JSON.parse(await directory.handle("directory", JSON.parse(JSON.stringify(m)) as unknown)) as Record<string, unknown>;
      if (opts.grouping.snapshot) await ask(groupingPutMessage(opts.grouping.snapshot));
      for (let k = 0; k < opts.isolates.count; k++) {
        const store = makeGroupingStore({ now: () => clock.now, freshMs: POOL_GROUPING_FRESH_MS });
        const state = opts.grouping.states[k % opts.grouping.states.length];
        if (state === "warm") store.install(entries, clock.now - 1_000, "read");
        if (state === "stale") store.install(entries, clock.now - 70_000, "read");
        const reader = makeGroupingReader({
          store,
          directory: () => ({ send: ask }),
          now: () => clock.now,
          timer: timerOnClock,
          boundMs: POOL_GROUPING_FETCH_MS,
          freshMs: POOL_GROUPING_FRESH_MS,
          retryMs: POOL_GROUPING_RETRY_MS,
          refreshAheadMs: POOL_GROUPING_REFRESH_AHEAD_MS,
        });
        groupings.push({ lineGroupOf: (code) => ladderGroupOf(code, store.peek), ensure: opts.grouping.fetch ? () => reader.ensure() : null });
      }
    }
    const bucketFor = (code: string) => {
      if (!opts.poolByCode) return { bucket: { ...fakeBucket, code } as typeof fakeBucket, eventType: fakeEventType };
      return opts.poolByCode[code]
        ? { bucket: { ...fakeBucket, code, id: `bkt-${code}` } as typeof fakeBucket, eventType: fakeEventType }
        : null;
    };
    let personReads = 0;
    // When the last slow reservation delete finished, from the burst's start.
    const cleanup = { endedMs: null as number | null };
    const shared: BookingDeps = {
      ...base,
      deleteReservation: async (id) => {
        if (opts.slowCleanupMs) {
          await clock.sleep(opts.slowCleanupMs);
          cleanup.endedMs = clock.now - burstStart;
        }
        return base.deleteReservation(id);
      },
      // The database's own per column fetch: equality on each signal, the grading
      // left to `findPersonMatch`, exactly as the real read does.
      findActiveBookingsForPerson: async (identity) => {
        if (opts.slowReadsMs) await clock.sleep(opts.slowReadsMs);
        personReads++;
        if (opts.failFirstPersonRead && personReads === 1) throw new Error("bookings read failed");
        return [...bySlot.values()].filter(
          (b) =>
            (identity.externalId && (b.external_id === identity.externalId || b.salesforce_id === identity.externalId)) ||
            (identity.salesforceId && (b.external_id === identity.salesforceId || b.salesforce_id === identity.salesforceId)) ||
            (identity.email && b.attendee_email?.toLowerCase() === identity.email.toLowerCase()) ||
            (identity.phone && b.attendee_phone === identity.phone),
        );
      },
      findActiveBookingsStartingAt: async (startIso) => {
        seatedReads.push(startIso);
        if (opts.failFirstSeatedRead && seatedReads.length === 1) throw new Error("seated read failed");
        return [...bySlot.values()].filter((b) => Date.parse(b.starts_at) === Date.parse(startIso));
      },
      verifyFree: async (...args) => {
        if (opts.slowGoogleMs) await clock.sleep(opts.slowGoogleMs);
        return base.verifyFree(...args);
      },
      busyIntervalsForAgent: async (...args) => {
        if (opts.slowRescheduleMs) await clock.sleep(opts.slowRescheduleMs / 2);
        return base.busyIntervalsForAgent(...args);
      },
      updateEventTime: async (...args) => {
        if (opts.slowRescheduleMs) await clock.sleep(opts.slowRescheduleMs / 2);
        return base.updateEventTime(...args);
      },
      createEvent: async (...args) => {
        if (opts.failFirstEventFor && args[0] === opts.failFirstEventFor && !eventFailed) {
          eventFailed = true;
          // Fails part way through the write, so the confirm beside it has already
          // read its candidates and is still booking when the claim is released.
          await clock.sleep((opts.slowEventMs ?? 0) / 2);
          throw new Error("calendar write failed");
        }
        if (opts.slowEventMs) await clock.sleep(opts.slowEventMs);
        return base.createEvent(...args);
      },
      confirmQueue: queue as BookingDeps["confirmQueue"],
      // #3338: the bucket carries the code it was asked for, so the ladder walked is
      // that code's own. With a pool per rung, each rung is its own bucket with its
      // own id, so a booking made on a lower rung can be told apart from one on the
      // top rung, and a code with no pool has no bucket row. Without one, the
      // requested code keeps the fixture's bucket id, so a lead holding a call in
      // it is in the same bucket.
      resolveBucketByCode: async (code: string) => bucketFor(code),
      // #3489: the walk's one ladder read. The fake candidate read below answers from the
      // bookings whatever it is handed, so the read carries only the rungs' buckets.
      ...(opts.ladderRead
        ? {
            readLadderInputs: async (codes: readonly string[]) => {
              const known = new Map(codes.map((code) => [code, bucketFor(code)]));
              const pool = await base.resolveBucketPool(fakeBucket);
              return {
                bucket: (code: string) => known.get(code) ?? null,
                covers: () => true,
                pool: () => pool,
                user: (id: string) => users[id] ?? null,
                emails: (ids: readonly string[]) => new Map(ids.flatMap((id) => (users[id]?.email ? [[id, users[id]!.email] as [string, string]] : []))),
              } as unknown as LadderInputs;
            },
          }
        : {}),
      roundRobinCandidates: async (b, _e, startMs) => {
        const taken = (id: string) => {
          const slot = `${id}|${new Date(startMs).toISOString()}`;
          return bySlot.has(slot) && !unseen.has(slot);
        };
        const pool = poolFor(b.code);
        return { candidates: pool.filter((id) => !taken(id)), memberCount: pool.length };
      },
      loadReservationByKey: async (key) => (opts.inFlight ?? []).find((r) => r.idempotency_key === key) ?? null,
      findBookingByIdempotencyKey: async (key) => {
        if (opts.failFirstIdempotencyReadOf === key && !idempotencyFailed) {
          idempotencyFailed = true;
          throw new Error("idempotency read failed");
        }
        return byKey.get(key) ?? null;
      },
      // The bookings table moves a rescheduled row to its new slot, and its
      // overlap index refuses a move onto a slot another booking holds.
      commitReschedule: async (id, patch, guard) => {
        const p = patch as { starts_at?: string; assigned_user_id?: string };
        const fromKey = [...bySlot.entries()].find(([, b]) => b.id === id)?.[0];
        const moving = fromKey ? bySlot.get(fromKey) : undefined;
        const toKey = `${p.assigned_user_id ?? moving?.assigned_user_id}|${p.starts_at ?? moving?.starts_at}`;
        const holder = bySlot.get(toKey);
        if (holder && holder.id !== id) return false;
        const ok = await base.commitReschedule(id, patch, guard);
        if (ok && fromKey && moving) {
          bySlot.delete(fromKey);
          bySlot.set(toKey, moving);
        }
        return ok;
      },
      insertBooking: async (row) => {
        calls.insertBooking.push(row as unknown as Record<string, unknown>);
        const slot = `${row.assigned_user_id}|${row.starts_at}`;
        if (bySlot.has(slot) || byKey.has(String(row.idempotency_key))) {
          raceLosses++;
          return { ok: false, conflict: true };
        }
        const booking = { ...row, id: `bk-${bySlot.size + 1}` } as unknown as Booking;
        bySlot.set(slot, booking);
        byKey.set(String(row.idempotency_key), booking);
        return { ok: true, booking };
      },
    };
    const runs: Run[] = opts.inputs.map(() => ({ calls: [] }));
    const t0 = clock.now;
    // #3489: what each call costs under the load model. The candidate read costs more
    // the more of its rung the cache shows free, which the bookings table here knows.
    const costOf = model
      ? databaseCosts(model.profile.database, (code, startMs) => {
          const instant = new Date(startMs).toISOString();
          return poolFor(code).filter((id) => {
            const slot = `${id}|${instant}`;
            return !(bySlot.has(slot) && !unseen.has(slot));
          }).length;
        })
      : undefined;
    // #3489: the deferred work after an answer, and the first answer on each isolate.
    const answeredOn = new Set<number>();
    const afterAnswer = (i: number, outcome: Outcome) => {
      if (!model) return;
      const d = model.profile.deferred;
      void occupy(clock, resource, d.tally, "booking-api-tally");
      if (outcome === "503") void occupy(clock, resource, d.failurePage, "booking-failure-page");
      if (outcome === "created") {
        void occupy(clock, resource, d.recompute, "post-confirm-recompute");
        void occupy(clock, resource, d.webhookSend, "webhook-first-send");
        void occupy(clock, resource, d.mirrorDelete, "gcal-mirror-delete");
      }
      const isolate = opts.isolates ? i % opts.isolates.count : 0;
      if (!answeredOn.has(isolate)) {
        answeredOn.add(isolate);
        void occupy(clock, resource, d.callerSeen, "api-caller-seen");
      }
    };
    // #3489: another lane's statements, one after another per caller, for as long as
    // any confirm could still be working (its budget and cleanup allowance), so a
    // confirm that never answers still ends the run as a hang rather than looping.
    for (let k = 0; k < (model?.backgroundCallers ?? 0); k++) {
      void (async () => {
        while (clock.now - t0 < BACKGROUND_UNTIL_MS) {
          await occupy(clock, resource, { latencyMs: model!.profile.database.meanStatementMs, queries: 1 }, "background-lane");
        }
      })();
    }
    const arrivalOf = (i: number) => (model ? model.arrivals[i]![0] : (opts.arriveAtMs?.[i] ?? 0));
    opts.inputs.forEach((one, i) => clock.at(t0 + arrivalOf(i), () => {
      const run = runs[i];
      const grouping = opts.isolates ? groupings[i % opts.isolates.count] : undefined;
      const onIsolate = opts.isolates
        ? {
            ...shared,
            confirmQueue: isolateLines[i % opts.isolates.count] as BookingDeps["confirmQueue"],
            ...(grouping
              ? {
                  lineGroupOf: (code: string) => {
                    const g = grouping.lineGroupOf(code);
                    run.group = g ?? `code:${code}`;
                    return g;
                  },
                }
              : {}),
            // #3338: each isolate keeps its own record of what its commit chains cost, as
            // production's module state does, so a confirm on an isolate that has run no
            // chain is judged on its own request alone.
            commitCosts: isolateCosts[i % opts.isolates.count],
          }
        : shared;
      const deps = onSharedCapacity(onIsolate, resource, clock, run.calls, SYNCHRONOUS, costOf);
      const startedAt = clock.now;
      // #3489: the route's own checks (the key, the ceilings) run inside the budget
      // before the confirm reaches its line, and a cold switch cache reads the switch
      // from the database meanwhile, which the confirm does not wait on past its deadline.
      const arrival = model?.arrivals[i];
      if (arrival && arrival[2] === 1) void occupy(clock, resource, model!.profile.deferred.switchRead, "shared-line-switch");
      const beforeLine = arrival ? () => clock.sleep(Math.max(0, arrival[1] - arrival[0])) : null;
      // #3460: the route awaits the grouping before the line key, as production does.
      const bookNow = opts.viaApi === false ? () => createBooking(one, deps) : () => bookViaApi(one, deps);
      const book = beforeLine ? async () => (await beforeLine(), bookNow()) : bookNow;
      const work = grouping?.ensure ? async () => (await grouping.ensure!(), book()) : book;
      void withinBookingConfirmBudget(work as () => Promise<unknown>).then(
        (res) => {
          run.outcome = (res as { outcome?: string }).outcome ?? "created";
          run.result = res as BookingResult;
          run.answeredMs = clock.now - startedAt;
          afterAnswer(i, run.outcome);
        },
        (err: unknown) => {
          run.error = err;
          run.outcome =
            timeoutAsRetryable(err) instanceof DependencyTimeoutError
              ? "503"
              : err instanceof SlotUnavailableError
                ? "SLOT_TAKEN"
                : err instanceof ExistingCallError
                  ? "EXISTING_CALL"
                  : err instanceof NoEligibleAgentsError
                    ? "NO_ELIGIBLE_AGENTS"
                    : `unexpected ${(err as Error)?.name}: ${(err as Error)?.message}`;
          run.answeredMs = clock.now - startedAt;
          afterAnswer(i, run.outcome);
        },
      );
    }));
    await clock.runUntil(() => runs.every((r) => r.outcome !== undefined));
    const tally: Record<string, number> = {};
    for (const r of runs) tally[r.outcome!] = (tally[r.outcome!] ?? 0) + 1;
    // #3338: what the crowd left behind in its line once every confirm answered. A
    // confirm that enters now must lead at once and find nobody's claim still held;
    // a line still held, or a claim still in it, is a confirm that never let go.
    let heldLines = 0;
    let claimsLeft = 0;
    if (opts.queue === "real") {
      let probed = false;
      const key = confirmQueueKey(opts.inputs[0].bucketCode, opts.inputs[0].startIso, undefined);
      void (async () => {
        // #3570: a line settled full answers a confirm arriving inside its memory from
        // that verdict, so the probe enters once the memory has lapsed: what it asks is
        // whether anything is STILL held, which a lease (14s) outlives the memory (5s) to show.
        await clock.sleep(CONFIRM_LINE_SETTLED_MEMORY_MS);
        for (const line of opts.isolates ? isolateLines : [queue]) {
          const turn = await line.enter(key, 0);
          if (turn.kind !== "lead") {
            heldLines++;
            continue;
          }
          claimsLeft += (await turn.seat.claimedByOthers()).size;
          await turn.done({ full: false });
        }
        probed = true;
      })();
      await clock.runUntil(() => probed);
    }
    // A reservation a confirm wrote and never removed is one the drain will finish. The
    // one call save (#3495) deletes it INSIDE itself, which is no recorded call, so its
    // own answer says whether it did.
    const savedAndDeleted = (c: { name: string; answer?: unknown }) => {
      const a = c.answer as { kind?: string; reservationDeleted?: boolean } | undefined;
      return c.name === "commitFreshBooking" && a?.kind === "committed" && a.reservationDeleted === true;
    };
    const reservationsLeftBy = (r: Run) =>
      r.calls.filter((c) => c.name === "insertReservation" && c.served).length -
      r.calls.filter((c) => c.name === "deleteReservation" && c.served).length -
      r.calls.filter(savedAndDeleted).length;
    // #3489: when each confirm was answered, from the burst's moment rather than its own.
    const answeredAtMs = runs.map((r, i) => arrivalOf(i) + r.answeredMs!);
    return { runs, tally, bySlot, calls, seatedReads, raceLosses, heldLines, claimsLeft, reservationsLeftBy, cleanupEndedMs: cleanup.endedMs, answeredAtMs };
  } finally {
    Date.now = realNow;
  }
}

const maxOf = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), 0);

/**
 * #3489 step 3: a line reached as a client from before #3489 reaches it: `claimFirst`
 * names no rung, so the line keeps the rules it had then (no frontier, no release, no
 * walking past a rung others hold). A turn handed back after waiting is wrapped too.
 */
function asOlderClient(line: ConfirmLine<unknown>): ConfirmLine<unknown> {
  const wrap = (turn: LineTurn<unknown>): LineTurn<unknown> =>
    turn.kind !== "lead"
      ? turn
      : {
          ...turn,
          seat: { ...turn.seat, claimFirst: (candidates) => turn.seat.claimFirst(candidates) },
          done: (verdict, outcome) => turn.done(verdict, outcome),
          park: async (waitMs) => wrap(await turn.park(waitMs)),
        };
  return { ...line, enter: async (key, waitMs) => wrap(await line.enter(key, waitMs)) };
}

/**
 * #3257: the reads a confirm may make AHEAD of a busy line (the replay check):
 * the idempotency read on the booker, the person decision on the booking API.
 */
const LOOKAHEAD_READS = new Set(["findBookingByIdempotencyKey", "resolveBucketByCode", "findActiveBookingsForPerson"]);

/**
 * Followers that did no work of their own: at most `CONFIRM_LINE_LOOKAHEAD` of
 * them made their one lookahead read, and nobody made any other call. This is the
 * whole bound on what a crowd behind a leader costs the database.
 */
function quiet(followers: Run[]): boolean {
  const readers = followers.filter((r) => r.calls.length > 0);
  return (
    readers.length <= CONFIRM_LINE_LOOKAHEAD &&
    readers.every((r) => r.calls.every((c) => LOOKAHEAD_READS.has(c.name)))
  );
}

/** #3489: one burst of load run 37640583621 replayed under a profile, and what it gave. */
interface Replayed {
  /** Each booking: when it was answered from the burst's moment, and how many rungs it dropped. */
  booked: { atMs: number; rungsDropped: number }[];
  /** Everyone else, by how they were answered: count, first, median and last answer. */
  others: Record<string, { count: number; firstMs: number; p50Ms: number; maxMs: number }>;
  doubleBooked: boolean;
}

const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;

/**
 * #3489: one burst of load run 37640583621 replayed under a profile. `over` changes the
 * database for a control: `slots` keeps the measured drain rate (slots over statement
 * time) and splits it differently; `statementMs` changes the drain rate itself;
 * `latencyScale` scales every call's own latency (what a call takes with nothing queued).
 */
async function replay(
  shape: BurstShape,
  profile: LoadProfile,
  line: "shared" | "isolate",
  over: { slots?: number; statementMs?: number; latencyScale?: number; olderClient?: boolean; objectHost?: ObjectHostFactory } = {},
): Promise<Replayed> {
  const poolByCode = Object.fromEntries(Object.entries(shape.rungs).map(([code, r]) => [code, [...r.free, ...r.busy]]));
  // An advisor the cache shows busy holds the instant with a lead of their own.
  const busy = [...new Set(Object.values(shape.rungs).flatMap((r) => r.busy))];
  const held = busy.map((id, k) =>
    makeBooking({
      id: `busy-${id}`,
      assigned_user_id: id,
      agent_name: `Agent ${id}`,
      agent_email: `${id}@x.com`,
      starts_at: input.startIso,
      external_id: `already-${k}`,
      salesforce_id: `sf-already-${k}`,
      attendee_email: `already${k}@example.com`,
      attendee_phone: `+1203559${String(1000 + k)}`,
      manage_token: `tok-already-${k}`,
    } as Partial<Booking>),
  );
  const split = over.slots
    ? { ...profile.database, slots: over.slots, statementMs: (profile.database.statementMs * over.slots) / profile.database.slots }
    : profile.database;
  const rated = over.statementMs ? { ...split, statementMs: over.statementMs } : split;
  const s = over.latencyScale;
  const database = s
    ? {
        ...rated,
        meanStatementMs: rated.meanStatementMs * s,
        callMs: Object.fromEntries(Object.entries(rated.callMs).map(([k, v]) => [k, v * s])),
        candidateReadMs: { noneFree: rated.candidateReadMs.noneFree * s, oneFree: rated.candidateReadMs.oneFree * s, manyFree: rated.candidateReadMs.manyFree * s },
      }
    : rated;
  const r = await burst({
    inputs: shape.arrivals.map((_, i) => lead(i, { bucketCode: shape.code })),
    pool: [],
    poolByCode,
    held,
    queue: "real",
    isolates: { count: shape.isolates, line },
    ...(over.olderClient ? { olderClient: true } : {}),
    ...(over.objectHost ? { objectHost: over.objectHost } : {}),
    ...(profile.name.startsWith("stack") ? { ladderRead: true } : {}),
    slowGoogleMs: profile.googleCheckMs || undefined,
    slowEventMs: profile.googleWriteMs || undefined,
    model: {
      profile: { ...profile, database },
      arrivals: shape.arrivals,
      firstAnswerMs: shape.firstAnswerMs,
      backgroundCallers: shape.syncLaneRunning ? profile.database.syncLaneCallers : 0,
    },
  });
  const booked = r.runs
    .map((run, i) => ({ run, atMs: r.answeredAtMs[i]! }))
    .filter(({ run }) => run.outcome === "created")
    .map(({ run, atMs }) => ({ atMs, rungsDropped: run.result?.booking.routing_trace?.rungs_dropped ?? -1 }))
    .sort((a, b) => a.atMs - b.atMs);
  const byOutcome: Record<string, number[]> = {};
  r.runs.forEach((run, i) => {
    if (run.outcome !== "created") (byOutcome[run.outcome!] ??= []).push(r.answeredAtMs[i]!);
  });
  const others = Object.fromEntries(
    Object.entries(byOutcome).map(([k, xs]) => [k, { count: xs.length, firstMs: Math.min(...xs), p50Ms: p50(xs), maxMs: maxOf(xs) }]),
  );
  const newRows = [...r.bySlot.values()].filter((b) => !String(b.id).startsWith("busy-"));
  const doubleBooked = new Set(newRows.map((b) => b.assigned_user_id)).size !== newRows.length;
  return { booked, others, doubleBooked };
}

const describe = (x: Replayed) =>
  `booked ${x.booked.map((b) => `${(b.atMs / 1000).toFixed(1)}s/rung${b.rungsDropped}`).join(", ") || "none"}; ` +
  Object.entries(x.others).map(([k, o]) => `${o.count} ${k} at ${(o.firstMs / 1000).toFixed(1)}..${(o.maxMs / 1000).toFixed(1)}s (p50 ${(o.p50Ms / 1000).toFixed(1)}s)`).join("; ");

async function main() {
  // --- #3489 step 0: every dependency the model prices is classified, by name ---
  //
  // The model charges a call to the database only when it is listed ON_DATABASE and
  // charges nothing for one listed OFF_DATABASE (Google, Salesforce, Slack), and it
  // refuses a name in neither. So every function dependency the confirm path can call
  // must be in exactly one of the two, or in this suite's SYNCHRONOUS set (not I/O at
  // all), and nothing may be listed that is not a dependency: a stale entry is a
  // classification of nothing, and a missing one is the next Google call silently
  // billed to the database (L96). Derived from the deps themselves, so a dependency
  // added to `BookingDeps` and its fakes fails here until somebody classifies it.
  {
    const { deps } = makeDeps({ candidates: ["p0"], freeEmails: new Set() });
    const names = Object.entries(deps).filter(([, v]) => typeof v === "function").map(([k]) => k);
    const sets = { onDatabase: ON_DATABASE, offDatabase: OFF_DATABASE, synchronous: SYNCHRONOUS };
    const got = classifyDeps(names, sets);
    assert(got.unclassified.length === 0, `load model: every dependency is classified (unclassified: ${got.unclassified.join(", ")})`);
    assert(got.twice.length === 0, `load model: no dependency is classified twice (${got.twice.join(", ")})`);
    // Stale is asked of the model's own two lists: the suite's synchronous set also names
    // optional dependencies the base fake leaves out (`lineGroupOf`, `deferSend`).
    // Optional dependencies the base fake leaves out ON PURPOSE, so a suite walks the
    // ladder the old way unless it opts in; the load model still prices them.
    const OPTIONAL_IN_FAKES = ["readLadderInputs"];
    const modelStale = classifyDeps([...names, ...OPTIONAL_IN_FAKES], { onDatabase: ON_DATABASE, offDatabase: OFF_DATABASE }).stale;
    assert(modelStale.length === 0, `load model: nothing the model classifies is missing from the deps (stale: ${modelStale.join(", ")})`);
    // Control (L1): a dependency nobody classified is caught by name.
    const planted = classifyDeps([...names, "readSomethingNew"], sets);
    assert(JSON.stringify(planted.unclassified) === JSON.stringify(["readSomethingNew"]), `load model control: a new dependency is reported unclassified (got ${JSON.stringify(planted.unclassified)})`);
    let refused = "";
    try {
      databaseCosts(LOAD_RUN_PROFILE.database, () => 0)("readSomethingNew", []);
    } catch (err) {
      refused = (err as Error).message;
    }
    assert(refused.includes("readSomethingNew"), `load model control: pricing an unclassified call throws by name (got ${JSON.stringify(refused)})`);
  }

  // --- #3489: a call is charged the REQUESTS it makes, not its latency over a statement --
  //
  // The database's limit is the request: Postgres spent 0.4% of wall time executing
  // statements while the app saw each call take 90 to 200ms (#3492's comment), and the
  // crowd drained at one REQUEST every ~35ms. So a call that is one request, however long
  // it takes, holds the drain for one request. The stack's two one request calls (#3495's
  // save, #3476's person read) were charged by their latency instead, six units and one,
  // which priced the save's cut as almost nothing (#3489's 2026-10-08 comment said 7%).
  {
    const price = databaseCosts(STACK_LOAD_RUN_PROFILE.database, () => 0);
    for (const name of ["commitFreshBooking", "findActiveBookingsForPerson"]) {
      const cost = price(name, []);
      assert(cost?.queries === 1, `load model: the stack's ${name} is ONE request (charged ${cost?.queries})`);
    }
    // Control (L1): a call with no stated count is still charged from its latency, so the
    // stated counts are what moved the two above (an advisor read priced at 270ms: three).
    const slowRead = databaseCosts({ ...STACK_LOAD_RUN_PROFILE.database, callMs: { ...STACK_LOAD_RUN_PROFILE.database.callMs, getUser: 270 } }, () => 0)("getUser", []);
    assert(slowRead?.queries === 3, `load model control: an uncounted call is charged by its latency (got ${slowRead?.queries})`);
  }

  // --- #3489: a call's requests run in the ROUNDS the code makes them, not one by one ----
  //
  // The candidate read makes seven requests in three rounds (members and users together,
  // then schedules and busy time together, then the cap count, the business hours beside
  // them), and the run timed it at 360ms alone. Served one after another, seven requests
  // of 70ms take 490ms before any network: the call came out slower than the run that
  // measured it, and every walker with it. So a call names its depth, and alone it takes
  // its measured latency whatever its count.
  {
    const clock = new VirtualClock(0);
    const resource = new SharedResource(clock, 2, 70);
    const ends: Record<string, number> = {};
    const alone = (cost: CallCost, name: string) =>
      occupy(clock, resource, cost, name).then(() => {
        ends[name] = clock.now;
      });
    void alone({ latencyMs: 360, queries: 7, depth: 3 }, "rounds");
    await clock.runUntil(() => "rounds" in ends);
    assert(ends.rounds === 360, `load model: a call of seven requests in three rounds takes its measured 360ms alone (took ${ends.rounds})`);
    // Control (L1): without a depth the same call is served one request after another.
    const start = clock.now;
    void alone({ latencyMs: 360, queries: 7 }, "serial");
    await clock.runUntil(() => "serial" in ends);
    assert(ends.serial! - start === 490, `load model control: with no depth the seven are served in turn, 490ms (took ${ends.serial! - start})`);
    // Each request of a round still holds a slot: a call of four at once on two slots is
    // all service (two turns, its 140ms alone), so two such calls at once take twice that.
    const both = clock.now;
    void alone({ latencyMs: 140, queries: 4, depth: 1 }, "wide-a");
    void alone({ latencyMs: 140, queries: 4, depth: 1 }, "wide-b");
    await clock.runUntil(() => "wide-a" in ends && "wide-b" in ends);
    assert(
      Math.max(ends["wide-a"]!, ends["wide-b"]!) - both === 280,
      `load model: two calls of four requests at once queue for the two slots, the later ending 280ms in (took ${Math.max(ends["wide-a"]!, ends["wide-b"]!) - both})`,
    );
  }

  {
    // And the calibration's database replays the code run 37640583621 ran: the seven
    // calls the save replaced, seven requests.
    const ran = databaseCosts(LOAD_RUN_PROFILE.database, () => 0)("commitFreshBooking", []);
    assert(ran?.queries === 7, `load model: the calibration prices the save as the seven requests it replaced (got ${ran?.queries})`);
  }

  // --- #3489: each call is charged the requests the CODE makes (counted 2026-10-08) ------
  //
  // Counted from `realDeps` and what it calls, cited in `confirm-load-model.ts`. Three were
  // wrong in ways that move where the drain goes: the live check reads the advisor and
  // the calendar row before it asks Google, so it is ON the database; the slot refresh
  // returns at once on the booking API (its splice runs after the answer); and the
  // candidate read is seven to nine requests, not the four to eight its latency implied.
  {
    for (const profile of [LOAD_RUN_PROFILE, STACK_LOAD_RUN_PROFILE]) {
      const free = { none: 0, one: 1, many: 5 } as const;
      for (const [kind, n] of Object.entries(free)) {
        const cost = databaseCosts(profile.database, () => n)("roundRobinCandidates", [{ code: "100" }, null, 0]);
        const want = { none: 7, one: 8, many: 9 }[kind as keyof typeof free];
        const deep = { none: 3, one: 4, many: 5 }[kind as keyof typeof free];
        assert(
          cost?.queries === want && cost.depth === deep,
          `load model (${profile.name}): the candidate read with ${kind} free is ${want} requests in ${deep} rounds (got ${cost?.queries} in ${cost?.depth})`,
        );
      }
      const price = databaseCosts(profile.database, () => 0);
      // #3495: the stack's live check reads only the calendar rows, the advisors' ids
      // riding with their emails; the run's read the advisors by email first.
      const liveCheck = profile === STACK_LOAD_RUN_PROFILE ? 1 : 2;
      const counted: Record<string, number> = {
        verifyFree: liveCheck,
        invalidateSlots: 0,
        deleteGcalMirrorBlock: 0,
        resolveBucketPool: 2,
        loadEmails: 1,
        displayedTier: 1,
      };
      for (const [name, want] of Object.entries(counted)) {
        assert(price(name, [])?.queries === want, `load model (${profile.name}): ${name} is ${want} requests on the booking API (got ${price(name, [])?.queries})`);
      }
      // The live check's reads are one after the other; the pool trace's two at once.
      assert(price("verifyFree", [])?.depth === liveCheck && price("resolveBucketPool", [])?.depth === 1, `load model (${profile.name}): the live check reads in turn and the pool trace at once (got ${price("verifyFree", [])?.depth} and ${price("resolveBucketPool", [])?.depth})`);
      // The work after a booking's answer, by request: the splice, the webhook's first
      // send (its claim and its outcome) and the stray mirror's delete.
      const d = profile.deferred;
      assert(
        d.recompute.queries === 7 && d.recompute.depth === 5 && d.webhookSend.queries === 2 && d.webhookSend.depth === 2 && d.mirrorDelete.queries === 1,
        `load model (${profile.name}): after a booking's answer, the splice is 7 requests, the webhook's send 2 and the mirror's delete 1 (got ${d.recompute.queries}, ${d.webhookSend.queries}, ${d.mirrorDelete.queries})`,
      );
    }
    // The person read the run's code made was four requests at once (each strong id on
    // two columns, the email, the phone); the stack's is one.
    // #3489: the walk's ladder read is one request on the stack, and a rung judged from it
    // reads nothing of its own, whatever the cache shows free.
    const stackPrice = databaseCosts(STACK_LOAD_RUN_PROFILE.database, () => 5);
    assert(stackPrice("readLadderInputs", [])?.queries === 1, `load model (stack): the ladder read is one request (got ${stackPrice("readLadderInputs", [])?.queries})`);
    const judged = stackPrice("roundRobinCandidates", [{ code: "100" }, null, 0, false, undefined, false, { inputs: {} }]);
    assert(judged?.queries === 0 && judged.latencyMs === 0, `load model (stack): a rung judged from the ladder read makes no request (got ${JSON.stringify(judged)})`);
    const oldPerson = databaseCosts(LOAD_RUN_PROFILE.database, () => 0)("findActiveBookingsForPerson", []);
    assert(oldPerson?.queries === 4 && oldPerson.depth === 1, `load model (load run): the old person read is four requests at once (got ${oldPerson?.queries} in ${oldPerson?.depth})`);
    assert(OFF_DATABASE.has("verifyFree") === false && ON_DATABASE.has("verifyFree"), "load model: the live check is classified on the database");
  }

  // --- #3489: the burst bar, asked of the load model on the stack ---------------------
  //
  // The model (`scripts/lib/confirm-load-model.ts`) was CALIBRATED against load run
  // 37640583621 on #3437's own head (#3494): each burst reproduced the run's shape, who
  // booked on which rung and how everybody else was answered, within a second. That
  // replays the code the run ran, which this branch no longer has: the one call save
  // (#3495), the one request person read (#3476), the ladder read and the line's step 3
  // rules all change what a confirm does. So, as #3489's plan said from the start, the
  // calibration is REPLACED here by the burst bar's target, never kept beside it: what
  // the judge asks of each burst (`judgeBurstLeg`), asked of the model of the stack.
  // The replay of the run's own code is still printed beside each, for the record.
  {
    for (const shape of RUN_37640583621) {
      const tag = `#3489 burst bar (model, stack load run), ${shape.label}`;
      // Distinct advisors: the ladder's pools overlap, so one advisor can be free on several rungs.
      const free = new Set(Object.values(shape.rungs).flatMap((r) => r.free)).size;
      const want = Math.min(free, shape.arrivals.length);
      const got = await replay(shape, STACK_LOAD_RUN_PROFILE, "shared");
      assert(!got.doubleBooked, `${tag}: no advisor is booked twice`);
      assert(got.booked.length === want, `${tag}: every free advisor the crowd can fill is booked, ${want} (got ${describe(got)})`);
      assert(
        Object.keys(got.others).every((k) => k === "SLOT_TAKEN"),
        `${tag}: everybody else is told the time is taken, never to retry (got ${describe(got)})`,
      );
      const lastBooked = maxOf(got.booked.map((b) => b.atMs));
      const taken = got.others.SLOT_TAKEN;
      assert(
        taken === undefined || taken.maxMs - lastBooked <= BURST_LOSER_LAG_MS,
        `${tag}: and told within ${BURST_LOSER_LAG_MS}ms of the last booking, the judge's bound (got ${taken ? Math.round(taken.maxMs - lastBooked) : 0}ms)`,
      );
      const ran = await replay(shape, LOAD_RUN_PROFILE, "shared", { olderClient: true });
      console.log(`${tag}: ${describe(got)}. The run's own code replayed: ${describe(ran)}`);
    }
    // #3529: load runs 37857243671 and 37863081340 planned their refusal bursts on a ladder
    // with four free on the top rung and seven to fourteen across it, which the 2026-10-07
    // run never met. The same bar, on burst 3's own arrivals with seven free.
    // Run 37871606406 met the thirteen free case with each rung read in round robin order, so
    // a lower rung's LAST advisor was one the rung above also holds and the line hands it
    // there: the third case reads every rung below the top in reverse to put one there.
    const thirteen = ["r0", "r1", "r2", "r3", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "r13", "r14"];
    const reversedBelow = (rungs: Record<string, BurstRung>): Record<string, BurstRung> =>
      Object.fromEntries(Object.entries(rungs).map(([code, r]) => [code, code === "500" ? r : { free: [...r.free].reverse(), busy: [...r.busy].reverse() }]));
    for (const [free, rungs, how] of [
      [["r0", "r1", "r2", "r3", "r6", "r7", "r8"], ladder500(["r0", "r1", "r2", "r3", "r6", "r7", "r8"]), ""],
      [thirteen, ladder500(thirteen), ""],
      [thirteen, reversedBelow(ladder500(thirteen)), ", a lower rung's last advisor also on the rung above"],
    ] as const) {
      const shape = { ...RUN_37640583621[2]!, label: `refusal control, ${free.length} free across the ladder${how}`, rungs };
      const tag = `#3529 burst bar (model, stack load run), ${shape.label}`;
      const want = Math.min(new Set(Object.values(shape.rungs).flatMap((r) => r.free)).size, shape.arrivals.length);
      const got = await replay(shape, STACK_LOAD_RUN_PROFILE, "shared");
      console.log(`${tag}: ${describe(got)}`);
      assert(!got.doubleBooked, `${tag}: no advisor is booked twice`);
      assert(got.booked.length === want, `${tag}: every free advisor the crowd can fill is booked, ${want} (got ${describe(got)})`);
      assert(Object.keys(got.others).every((k) => k === "SLOT_TAKEN"), `${tag}: everybody else is told the time is taken, never to retry (got ${describe(got)})`);
      const lastBooked = maxOf(got.booked.map((b) => b.atMs));
      const taken = got.others.SLOT_TAKEN;
      assert(taken === undefined || taken.maxMs - lastBooked <= BURST_LOSER_LAG_MS, `${tag}: and told within ${BURST_LOSER_LAG_MS}ms of the last booking (got ${taken ? Math.round(taken.maxMs - lastBooked) : 0}ms)`);
    }
    // #3570: load run 37977451270, burst 3, met three free (two on the top rung) and one
    // confirm on a fresh isolate that reached the line about 60ms after the full verdict
    // had answered the crowd. It led a line of its own, ran the whole confirm and was
    // told the time was taken 5.9s after the last booking. In the model the crowd's
    // verdict lands about 5.2s in, so a confirm arriving at 5.2s, 5.6s or 6.4s met the
    // same: answered at about 12s. The line remembers the verdict for them now.
    for (const lateMs of [5_200, 5_600, 6_400]) {
      const base = RUN_37640583621[2]!;
      const three = ["r0", "r1", "r9"];
      const shape = { ...base, label: `refusal control, 3 free, one more arriving ${lateMs}ms in`, rungs: ladder500(three), arrivals: [...base.arrivals, [lateMs - 50, lateMs, 1] as const] };
      const tag = `#3570 burst bar (model, stack load run), ${shape.label}`;
      const got = await replay(shape, STACK_LOAD_RUN_PROFILE, "shared");
      console.log(`${tag}: ${describe(got)}`);
      assert(!got.doubleBooked && got.booked.length === 3, `${tag}: the three free advisors are booked, once each (got ${describe(got)})`);
      const lastBooked = maxOf(got.booked.map((b) => b.atMs));
      const taken = got.others.SLOT_TAKEN;
      assert(taken !== undefined && taken.count === shape.arrivals.length - 3, `${tag}: everybody else is told the time is taken (got ${describe(got)})`);
      assert(taken!.maxMs - lastBooked <= BURST_LOSER_LAG_MS, `${tag}: the late one too, within ${BURST_LOSER_LAG_MS}ms of the last booking (got ${Math.round(taken!.maxMs - lastBooked)}ms)`);
    }
    // #3560: load run 37869019791 ran a newer app against a line object one release older,
    // and each refusal burst's crowd waited about 11 seconds to be told to retry. Driven
    // offline against the object at c51bcfae (the build that run's line Worker was on, not
    // kept in the tree), the stack's crowd of 100 on the thirteen free shape booked thirteen
    // and answered 75 of the rest 503 at 10.1 to 10.9s: the newer client decides the full
    // verdict from `StartFrom.last` and `deepest`, which only a newer object hands out, so
    // nobody reported the ladder spent and the crowd waited out its whole wait.
    //
    // The client now asks for protocol 2, every object ever deployed refuses a protocol it
    // does not serve before acting on it, and the client takes that refusal as what it is
    // and uses its isolate's own line, and pages. So a line Worker rolled back alone is the
    // shared line switched OFF, the state production runs today, never an untested mix of
    // two builds. That is what this holds, and it is NOT that the crowd books: in this
    // model a crowd on per isolate lines books one or none, as load run 37333201026 did for
    // real, which is why the shared line exists. Only the deploy refusing the order keeps a
    // crowd served (#3560's other half, reported on the issue). The older object here is the
    // current one behind the refusal an older build makes, which is all of an older object
    // the client can now meet.
    {
      const olderObject = (d: Parameters<typeof makeConfirmLineHost>[0]): ObjectHost => {
        const h = makeConfirmLineHost(d);
        return {
          handle: async (m) =>
            (m as Record<string, unknown>).v === CONFIRM_LINE_PROTOCOL - 1 ? h.handle(m) : JSON.stringify({ kind: "gone", why: "version" }),
        };
      };
      for (const free of [["r0", "r1", "r2", "r3", "r6", "r7", "r8"], ["r0", "r1", "r2", "r3", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "r13", "r14"]]) {
        for (const crowd of [25, 100]) {
          const base = { ...RUN_37640583621[2]!, rungs: ladder500(free) };
          const shape = { ...base, label: `refusal control, ${free.length} free across the ladder, a crowd of ${crowd}`, arrivals: base.arrivals.slice(0, crowd) };
          const tag = `#3560 a line object older than the app, ${shape.label}`;
          const got = await replay(shape, STACK_LOAD_RUN_PROFILE, "shared", { objectHost: olderObject });
          const off = await replay(shape, STACK_LOAD_RUN_PROFILE, "isolate");
          console.log(`${tag}: ${describe(got)}. The same crowd with the shared line off: ${describe(off)}`);
          assert(!got.doubleBooked, `${tag}: no advisor is booked twice`);
          assert(
            got.booked.length === off.booked.length && JSON.stringify(Object.keys(got.others).sort()) === JSON.stringify(Object.keys(off.others).sort()),
            `${tag}: answered as the same crowd is with the shared line switched off (got ${describe(got)}; off ${describe(off)})`,
          );
        }
      }
    }
    // Control (L1): the bar can fail. Priced at the run's own database cost, with none of
    // the stack's cuts (every rung read with requests of its own, the save as the seven
    // calls it replaced), the tier drop burst books fewer than its twelve.
    const drop = RUN_37640583621[1]!;
    const old = await replay(drop, LOAD_RUN_PROFILE, "shared");
    assert(
      old.booked.length < drop.arrivals.length,
      `#3489 burst bar control: at the run's own database cost the tier drop burst misses the bar (got ${describe(old)})`,
    );
    // What the same model says about the configurations the run did not measure,
    // recorded and not asserted (#3489's PR carries them): the per isolate line, which
    // production runs today, and production's Google time.
    for (const shape of RUN_37640583621) {
      for (const [profile, line] of [
        [LOAD_RUN_PROFILE, "isolate"],
        [PRODUCTION_PROFILE, "shared"],
        [PRODUCTION_PROFILE, "isolate"],
        // The stack's database cost (#3495's one call save, #3476's one request person read).
        [STACK_LOAD_RUN_PROFILE, "shared"],
        [STACK_PRODUCTION_PROFILE, "shared"],
      ] as const) {
        console.log(`#3489 model, ${shape.label}, ${profile.name}, ${line} line: ${describe(await replay(shape, profile, line))}`);
      }
    }
  }

  // --- CONTROL: the incident, reproduced with the queue switched off ----------
  {
    const { runs, tally, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "off",
    });
    assert(bySlot.size === 0, `control: nobody is booked, as on 2026-10-04 (got ${bySlot.size})`);
    assert(tally["503"] === BURST, `control: all ${BURST} answered with the retryable 503 (got ${JSON.stringify(tally)})`);
    assert(
      runs.every((r) => r.answeredMs === BOOKING_CONFIRM_BUDGET_MS),
      `control: every one is answered when the budget runs out, not before (got ${[...new Set(runs.map((r) => r.answeredMs))].join(",")})`,
    );
    // Where the time went: queued behind the others, not working, and not yet at
    // the insert, which is the only place two of them could ever have met.
    const queued = runs.reduce((a, r) => a + r.calls.reduce((s, c) => s + c.queuedMs, 0), 0);
    const share = queued / (BURST * BOOKING_CONFIRM_BUDGET_MS);
    assert(share > 0.85, `control: most of each request's time was spent queued for the shared capacity (${Math.round(share * 100)}%)`);
    // The save is ONE recorded call since #3495 (`commitFreshBooking`); the insert inside
    // it is the fake's own step and is never recorded, so it is the save that is counted.
    const reachedInsert = runs.filter((r) => r.calls.some((c) => c.name === "commitFreshBooking" && c.served)).length;
    assert(reachedInsert === 0, `control: no request got as far as the save before the budget ran out (got ${reachedInsert})`);
    const stoppedAt: Record<string, number> = {};
    for (const r of runs) {
      const last = r.calls.find((c) => c.timedOut)?.name ?? "none";
      stoppedAt[last] = (stoppedAt[last] ?? 0) + 1;
    }
    console.log("control: the call each request was cut off in:", JSON.stringify(stoppedAt));
  }

  // --- THE FIX: one created, every other one SLOT_TAKEN, inside the budget ----
  {
    const { runs, tally, bySlot, calls } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "real",
    });
    assert(tally.created === 1, `burst: exactly one confirm is booked (got ${JSON.stringify(tally)})`);
    assert(tally.SLOT_TAKEN === BURST - 1, `burst: every other one is told SLOT_TAKEN (got ${JSON.stringify(tally)})`);
    assert(!tally["503"], `burst: none is answered 503 (got ${tally["503"] ?? 0})`);
    assert(bySlot.size === 1, "burst: one booking row, so never a double booking");
    assert(runs[0].outcome === "created", "burst: the FIRST confirm in is the one booked");
    // Positive control for the two checks that count the save by name (L1): the booked
    // confirm's own calls carry it, served, so a check for its absence can fail.
    assert(
      runs[0].calls.some((c) => c.name === "commitFreshBooking" && c.served),
      "burst: the booked confirm's save is recorded as commitFreshBooking, served",
    );
    const loserTimes = runs.filter((r) => r.outcome === "SLOT_TAKEN").map((r) => r.answeredMs!);
    assert(
      maxOf(loserTimes) < BOOKING_CONFIRM_BUDGET_MS / 2,
      `burst: every loser is answered inside half the budget (slowest ${maxOf(loserTimes)}ms)`,
    );
    assert(calls.createEvent.length === 1, `burst: only the winner writes to the agent's calendar (got ${calls.createEvent.length})`);
    assert(calls.reservations.length === 1, `burst: only the winner writes a reservation (got ${calls.reservations.length})`);
    assert(calls.verifyFree.length === 1, `burst: only the winner asks Google whether the agent is free (got ${calls.verifyFree.length})`);
    const losers = runs.filter((r) => r.outcome === "SLOT_TAKEN");
    assert(
      losers.every((r) => r.calls.every((c) => !c.timedOut)),
      "burst: no loser had a call cut off by the budget",
    );
  }

  // --- CONTROL: two different slots for the same agent both book --------------
  {
    const { tally, bySlot } = await burst({
      inputs: [lead(0), lead(1, { startIso: "2026-06-08T14:00:00.000Z" })],
      pool: ["a"],
      queue: "real",
    });
    assert(tally.created === 2, `two slots: both confirms are booked (got ${JSON.stringify(tally)})`);
    assert(bySlot.size === 2, "two slots: two booking rows");
  }

  // --- #3325: the 2026-10-05 failure, reproduced: one line PER ISOLATE ---------
  //
  // Load run 37333201026 sent a hundred confirms for one slot and they landed on
  // many isolates, each forming its own line: about 52 leaders ran the full path
  // together and timed out on the database. Fifty isolates of two confirms each is
  // that shape: fifty leaders at once. What is asserted is the failure the load
  // run's burst bar counts, confirms told to retry rather than told the time is
  // taken, and NOT that nobody is booked: this model of the database lets one
  // leader through where production let none, and tuning it until it matched would
  // make the fixture prove only itself (L48). The shared line case below runs the
  // identical crowd and must answer none of them retryably.
  //
  // What is asserted is the failure's CAUSE, one leader per isolate running the full
  // path at once, and not its symptom. The symptom, confirms told to retry, is how many
  // of those leaders this model's database runs out of time on, and it shrinks every
  // time a booking's path does: 40 or more while the save was six calls, 18 once it
  // was one (#3495 step 3, 2026-10-07), 1 once a fresh confirm stopped reading its key
  // twice (#3495, 2026-10-14). A floor tuned down after each cut would end up proving
  // nothing (L48); the leader count is the shape that failed on the load run, and the
  // shared line case below runs the identical crowd and must have exactly one.
  {
    const { runs, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "real",
      isolates: { count: 50, line: "isolate" },
    });
    const leaders = runs.filter((r) => r.calls.some((c) => c.name === "insertReservation")).length;
    assert(leaders === 50, `per isolate lines: every isolate's leader runs the full path at once, the 2026-10-05 failure (got ${leaders} of 50 isolates)`);
    assert(bySlot.size <= 1, `per isolate lines: still never a double booking (got ${bySlot.size})`);
  }

  // --- #3325: the same crowd on ONE line shared across those isolates ----------
  {
    const { runs, tally, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "real",
      isolates: { count: 50, line: "shared" },
    });
    assert(bySlot.size === 1 && tally.created === 1, `shared line: exactly one confirm is booked (got ${JSON.stringify(tally)})`);
    const leaders = runs.filter((r) => r.calls.some((c) => c.name === "insertReservation")).length;
    assert(leaders === 1, `shared line: one leader runs the full path for the whole crowd (got ${leaders})`);
    assert(tally.SLOT_TAKEN === BURST - 1, `shared line: every other one is told SLOT_TAKEN (got ${JSON.stringify(tally)})`);
    assert(!tally["503"], `shared line: none is answered 503 (got ${tally["503"] ?? 0})`);
    const winner = runs.find((r) => r.outcome === "created")!;
    const lastLoser = maxOf(runs.filter((r) => r.outcome === "SLOT_TAKEN").map((r) => r.answeredMs!));
    assert(
      lastLoser <= winner.answeredMs! + 2_000,
      `shared line: every loser hears "taken" within 2s of the winner's answer (winner ${winner.answeredMs}ms, last loser ${lastLoser}ms)`,
    );
  }

  // --- #3460: a burst on two SIBLING codes across warm, cold and stale servers ---
  //
  // Load run 37566700055, burst 3: a hundred confirms for one slot on codes 120 and 121,
  // whose ladders walk the same pools. 85 ran on servers holding no fresh grouping, so
  // they keyed their codes' own lines, and the burst split across `ladder:`, `code:120`
  // and `code:121`: three leaders, and a slow losing one timed out 41 followers. The mix
  // matters (L246): an all cold crowd given a snapshot is the easy case, so these
  // servers are warm, cold and stale together, as that run's were.
  {
    const T = Date.parse("2026-06-01T00:00:00.000Z");
    const siblings = Array.from({ length: BURST }, (_, i) => lead(i, { bucketCode: i % 2 === 0 ? "120" : "121", prefill: { xbc: i % 2 === 0 ? "120" : "121" } }));
    const isolates = { count: 10, line: "shared" as const };
    const states: GroupingState[] = ["warm", "cold", "stale"];
    const fresh = groupingSnapshotOf(groupingEntriesOf(groupByPool(poolGroupingRoster())), T - 5_000);
    const leadersOf = (runs: Run[]) => runs.filter((r) => r.calls.some((c) => !LOOKAHEAD_READS.has(c.name)));
    const groupsOf = (runs: Run[]) => [...new Set(runs.map((r) => r.group ?? "none"))].sort();

    // CONTROL, main before #3460: each confirm keys on what its own isolate holds.
    {
      const { runs, tally, bySlot } = await burst({ inputs: siblings, pool: ["a"], queue: "real", isolates, grouping: { states, snapshot: fresh, fetch: false } });
      const groups = groupsOf(runs);
      assert(
        groups.length === 3 && groups.includes("code:120") && groups.includes("code:121") && groups.some((g) => g.startsWith("ladder:")),
        `siblings, main: the burst splits across a ladder line and both codes' own lines, as in run 37566700055 (got ${groups.join(", ")})`,
      );
      const leaders = leadersOf(runs);
      assert(leaders.length >= 2, `siblings, main: so it elects more than one leader (got ${leaders.length})`);
      assert(bySlot.size === 1, `siblings, main: still never a double booking (got ${bySlot.size}, ${JSON.stringify(tally)})`);
    }

    // THE FIX: each confirm fetches the snapshot before its line key.
    {
      const { runs, tally, bySlot } = await burst({ inputs: siblings, pool: ["a"], queue: "real", isolates, grouping: { states, snapshot: fresh, fetch: true } });
      const groups = groupsOf(runs);
      assert(groups.length === 1 && groups[0]!.startsWith("ladder:"), `siblings, snapshot: every confirm on every server joins ONE ladder line (got ${groups.join(", ")})`);
      // #3338: 120's ladder has rungs below the top one, every one of them the same one
      // advisor here, so the winner's booking does not settle the line: the next
      // confirm leads, walks the rest of the ladder, finds it spent, and that verdict
      // answers everybody else. Two leaders, on ONE line, where main's split elected
      // one per line before any of them walked.
      const leaders = leadersOf(runs);
      assert(leaders.length === 2, `siblings, snapshot: which elects the winner and the one confirm that walks the ladder to find it spent (got ${leaders.length})`);
      assert(tally.created === 1 && bySlot.size === 1, `siblings, snapshot: exactly one confirm is booked (got ${JSON.stringify(tally)})`);
      assert(tally.SLOT_TAKEN === BURST - 1, `siblings, snapshot: and every other confirm is answered SLOT_TAKEN (got ${JSON.stringify(tally)})`);
      assert(!tally["503"], `siblings, snapshot: none is answered 503 (got ${tally["503"] ?? 0})`);
      const walker = leaders.find((r) => r.outcome === "SLOT_TAKEN");
      assert(walker !== undefined, "siblings, snapshot: the second leader is the one told the ladder is spent");
      assert(
        quiet(runs.filter((r) => r.outcome === "SLOT_TAKEN" && r !== walker)),
        "siblings, snapshot: and no other follower runs a chain of its own",
      );
    }

    // Every refusal keeps today's behaviour: the code's own line, never a guess.
    for (const [label, snapshot] of [
      ["a stale snapshot", groupingSnapshotOf(fresh.entries, T - POOL_GROUPING_FRESH_MS - 1_000)],
      ["no snapshot", null],
      ["a partial snapshot", { ...fresh, entries: fresh.entries.slice(0, 20) }],
    ] as const) {
      const { runs, bySlot } = await burst({ inputs: siblings, pool: ["a"], queue: "real", isolates, grouping: { states, snapshot: snapshot as GroupingSnapshot | null, fetch: true } });
      const groups = groupsOf(runs);
      assert(groups.includes("code:120") && groups.includes("code:121"), `siblings, ${label}: cold and stale servers keep their codes' own lines (got ${groups.join(", ")})`);
      assert(bySlot.size === 1, `siblings, ${label}: and still never a double booking`);
    }
  }

  // --- a pool of two: two booked, the rest SLOT_TAKEN, none 503 ---------------
  {
    const { runs, tally, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a", "b"],
      queue: "real",
    });
    assert(tally.created === 2 && tally.SLOT_TAKEN === BURST - 2, `pool of two: two booked, the rest taken (got ${JSON.stringify(tally)})`);
    assert(!tally["503"], "pool of two: none is answered 503");
    const agents = [...bySlot.values()].map((b) => b.assigned_user_id).sort();
    assert(JSON.stringify(agents) === JSON.stringify(["a", "b"]), `pool of two: one booking per advisor (got ${JSON.stringify(agents)})`);
    // The first in leads; the second may have looked ahead (#3257) and rejoined
    // behind, so which confirm takes the second advisor is not pinned.
    assert(runs[0].outcome === "created", "pool of two: the first in is booked");
  }

  // --- a double submit collapses onto one booking, never told it is taken -----
  {
    const same = lead(7);
    const { runs, bySlot } = await burst({ inputs: [same, same], pool: ["a"], queue: "real", viaApi: false });
    assert(
      runs.every((r) => r.outcome === "created"),
      `double submit: both submits get the booking (got ${runs.map((r) => r.outcome).join(",")})`,
    );
    assert(bySlot.size === 1, "double submit: one booking row");
    assert(
      runs[0].result?.booking.id === runs[1].result?.booking.id,
      "double submit: both answers name the same booking",
    );
    assert(runs[1].result?.newlyInserted === undefined, "double submit: the second is not counted as a booking it made");
  }

  // --- a follower is refused as a lost race, so the routes count it as one ----
  {
    const { runs } = await burst({ inputs: [lead(0), lead(1)], pool: ["a"], queue: "real", viaApi: false });
    const err = runs[1].error;
    assert(
      err instanceof RaceLostRefusalError && err.lostRaces === 1 && err.boundHit === false,
      `refusal: the follower is refused as one lost race, bound not hit (got ${String(err)})`,
    );
    // #3272: and it says so: the stage is the line's, with the instant and bucket it
    // asked for and what the confirm ahead of it was refused as.
    const t = refusalTraceOf(err);
    assert(
      t?.stage === "follower" &&
        t.requestedStart === lead(1).startIso &&
        t.bucketCode === lead(1).bucketCode &&
        t.leaderRefusal === "race",
      `refusal: the follower's trace names its stage, instant and bucket (got ${JSON.stringify(t)})`,
    );
  }

  // --- #3257: a slow database, so the reads BEFORE the line are what time out ---
  //
  // Run 37229344882 (2026-10-04) met the burst with the #3221 line in place and
  // still booked nobody: every request timed out on the bucket read, the person
  // read and the idempotency read, which all ran before the line. At 50ms a call
  // on a capacity of one, those three reads alone for a hundred confirms are 15
  // seconds of serial work against a 12 second budget. The line has to be entered
  // before any of them, so a follower does no read at all while the leader runs.
  const PRE_LINE_READS = new Set(["resolveBucketByCode", "findActiveBookingsForPerson", "findBookingByIdempotencyKey"]);
  const SLOW_MS = 50;
  for (const viaApi of [true, false]) {
    const label = viaApi ? "slow db, booking API" : "slow db, booker confirm";
    const { runs, tally, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "real",
      viaApi,
      serviceMs: SLOW_MS,
    });
    assert(tally.created === 1, `${label}: exactly one confirm is booked (got ${JSON.stringify(tally)})`);
    assert(tally.SLOT_TAKEN === BURST - 1, `${label}: every other one is told SLOT_TAKEN (got ${JSON.stringify(tally)})`);
    assert(!tally["503"], `${label}: none is answered 503 (got ${tally["503"] ?? 0})`);
    assert(bySlot.size === 1, `${label}: one booking row`);
    assert(runs[0].outcome === "created", `${label}: the first confirm in is the one booked`);
    const followers = runs.slice(1);
    const readers = followers.filter((r) => r.calls.some((c) => PRE_LINE_READS.has(c.name)));
    assert(
      readers.length <= CONFIRM_LINE_LOOKAHEAD,
      `${label}: no follower reads the bucket, the person or the idempotency key while the leader runs (got ${readers.length})`,
    );
    assert(
      quiet(followers),
      `${label}: no follower does work of its own beyond the bounded lookahead (most made ${maxOf(followers.map((r) => r.calls.length))})`,
    );
    const loserTimes = followers.map((r) => r.answeredMs!);
    assert(
      maxOf(loserTimes) < BOOKING_CONFIRM_BUDGET_MS / 2,
      `${label}: every loser is answered inside half the budget (slowest ${maxOf(loserTimes)}ms)`,
    );
  }

  // --- #3257: a pool of two on the slow database: two booked, none 503 ---------
  {
    const { tally, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a", "b"],
      queue: "real",
      serviceMs: SLOW_MS,
    });
    assert(tally.created === 2 && tally.SLOT_TAKEN === BURST - 2, `slow pool of two: two booked, the rest taken (got ${JSON.stringify(tally)})`);
    assert(bySlot.size === 2, "slow pool of two: two booking rows");
  }

  // --- #3257: a leader that ERRORS does not take the crowd down with it ---------
  //
  // The first confirm's person read fails. It answers with that failure (the
  // route maps it), it settles nothing about the slot, so the second in line leads
  // with a full chain of its own and books, and the other 98 are told SLOT_TAKEN.
  {
    const { runs, tally, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "real",
      serviceMs: SLOW_MS,
      failFirstPersonRead: true,
    });
    assert(
      runs[0].outcome !== "created" && runs[0].outcome !== "SLOT_TAKEN",
      `failed leader: the first confirm answers with its own failure (got ${runs[0].outcome})`,
    );
    assert(
      runs.slice(1).filter((r) => r.outcome === "created").length === 1,
      `failed leader: one of those waiting leads and is booked (got ${JSON.stringify(tally)})`,
    );
    assert(tally.created === 1 && bySlot.size === 1, `failed leader: exactly one booking (got ${JSON.stringify(tally)})`);
    assert(tally.SLOT_TAKEN === BURST - 2, `failed leader: the rest are told SLOT_TAKEN (got ${JSON.stringify(tally)})`);
    assert(!tally["503"], `failed leader: none is answered 503 (got ${tally["503"] ?? 0})`);
    assert(
      quiet(runs.slice(1).filter((r) => r.outcome === "SLOT_TAKEN")),
      "failed leader: the followers answered from the new leader made no dependency call",
    );
  }

  // --- #3257: a double submit through the booking API still gets its booking ---
  //
  // #4019: and the second is told `deduped`, since the booking already existed when it
  // was answered. It used to be told `created` when it was answered from the first
  // call's verdict in the line, and `deduped` when it ran the person decision itself,
  // so the same resubmit got two labels depending on timing, and a caller told
  // `created` for a booking it already holds may treat it as a new one.
  {
    const same = lead(7);
    const { runs, bySlot } = await burst({ inputs: [same, same], pool: ["a"], queue: "real", serviceMs: SLOW_MS });
    assert(runs[0].outcome === "created", `api double submit: the first submit is booked (got ${runs[0].outcome})`);
    assert(runs[1].outcome === "deduped", `api double submit: the second is answered deduped (got ${runs[1].outcome})`);
    assert(bySlot.size === 1, "api double submit: one booking row");
    assert(
      Boolean(runs[0].result && runs[1].result) && runs[0].result?.booking.id === runs[1].result?.booking.id,
      "api double submit: both answered with the same booking",
    );
    const second = runs[1].result as { manageUrl?: string; raceOutcome?: unknown } | undefined;
    assert(
      second?.manageUrl === (runs[0].result as { manageUrl?: string } | undefined)?.manageUrl,
      "api double submit: the second carries the booking's manage link",
    );
    assert(second?.raceOutcome === undefined, "api double submit: the second records no race row");
  }

  // --- #4019: a resubmit AFTER the first call answered, the production canary's case ---
  //
  // The canary sends an identical request once the first has returned. When the first
  // booked the ladder's last advisor its full verdict settles the line, and the line
  // remembers that verdict for `CONFIRM_LINE_SETTLED_MEMORY_MS` (#3570), so a resubmit
  // inside that window is answered from the first call's booking without running
  // anything. Past the window it runs the person decision. Both must say `deduped`.
  for (const [label, gapMs] of [
    ["inside the settled memory", 1_000],
    ["after the settled memory", CONFIRM_LINE_SETTLED_MEMORY_MS + 1_000],
  ] as const) {
    const same = lead(7);
    const firstAnswersBy = 500;
    const { runs, bySlot } = await burst({
      inputs: [same, same],
      pool: ["a"],
      queue: "real",
      arriveAtMs: [0, firstAnswersBy + gapMs],
    });
    const tag = `api resubmit ${label}`;
    assert(
      runs[0].outcome === "created" && runs[0].answeredMs! < firstAnswersBy,
      `${tag}: the first call is booked and answered before the resubmit is sent (got ${runs[0].outcome} in ${runs[0].answeredMs}ms)`,
    );
    assert(runs[1].outcome === "deduped", `${tag}: the resubmit is answered deduped (got ${runs[1].outcome})`);
    assert(bySlot.size === 1, `${tag}: one booking row`);
    assert(runs[0].result?.booking.id === runs[1].result?.booking.id, `${tag}: the resubmit names the first call's booking`);
    const second = runs[1].result as { manageUrl?: string; raceOutcome?: unknown } | undefined;
    assert(
      second?.manageUrl === (runs[0].result as { manageUrl?: string } | undefined)?.manageUrl,
      `${tag}: the resubmit carries the booking's manage link`,
    );
    assert(second?.raceOutcome === undefined, `${tag}: the resubmit records no race row`);
  }

  // --- #3257: where the line can be entered before any read ---------------------
  {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const instant = String(Date.parse(input.startIso));
    // #3325: a key is a GROUP (whose confirms can settle each other) and an instant.
    assert(
      same(confirmQueueKey("120", input.startIso, undefined), { group: "code:120", instant }),
      `key: a code's line is its code and the parsed instant (got ${JSON.stringify(confirmQueueKey("120", input.startIso, undefined))})`,
    );
    assert(
      same(confirmQueueKey("120", input.startIso, "u1"), { group: "link:u1", instant }),
      "key: a named link's line is its advisor's, whichever code it came through, since the same person is contended",
    );
    // #3325: a code whose whole fallback ladder this isolate knows joins its LADDER's
    // line, shared with sibling codes; one it does not know keeps its own code's line.
    const ladderOf = (code: string) => (code === "120" ? "ladder:abc" : null);
    assert(
      same(confirmQueueKey("120", input.startIso, undefined, ladderOf), { group: "ladder:abc", instant }),
      "key: a code whose ladder is known joins the ladder's line",
    );
    assert(
      same(confirmQueueKey("121", input.startIso, undefined, ladderOf), { group: "code:121", instant }),
      "key: a code whose ladder is not known keeps its own line",
    );
    assert(
      same(confirmQueueKey("120", input.startIso, "u1", ladderOf), { group: "link:u1", instant }),
      "key: a named link is the advisor's line whatever the ladder",
    );
    assert(
      same(queueKeyBeforeRouting({ bucketCode: "120", startIso: input.startIso }, ladderOf), { group: "ladder:abc", instant }),
      "early key: the ladder is known before any read, from what the isolate already holds",
    );
    assert(
      same(queueKeyBeforeRouting({ bucketCode: "120", startIso: input.startIso }), confirmQueueKey("120", input.startIso, undefined)),
      "early key: a request naming its bucket outright is keyed before any read",
    );
    assert(
      same(queueKeyBeforeRouting({ bucketCode: "120", startIso: input.startIso, requestedCode: "120" }), confirmQueueKey("120", input.startIso, undefined)),
      "early key: a booker link carrying a routable code is keyed before any read",
    );
    assert(
      same(queueKeyBeforeRouting({ bucketCode: "120", startIso: input.startIso, agentLinkUserId: "u1" }), confirmQueueKey("120", input.startIso, "u1")),
      "early key: a named link is keyed on its advisor before any read",
    );
    assert(
      queueKeyBeforeRouting({ bucketCode: "000", startIso: input.startIso, requestedCode: "not-a-code" }) === null,
      "early key: a link Salesforce routes is NOT keyed before routing, since the code it books is not yet known",
    );
  }

  // --- #3257 review: a lead who ALREADY holds the time is told so -------------
  //
  // Lead 50 already holds 13:00 with the pool's only advisor and submits it again
  // in the crowd. The person decision answers that `deduped` (or, for the booker,
  // "you already have a call"), never SLOT_TAKEN. The leader reads who sits at the
  // instant once and hands it down; only a follower that matches it runs its own
  // chain, so the crowd still reads nothing.
  const HOLDER = 50;
  const holding = (over: Partial<Booking> = {}) =>
    makeBooking({
      id: "held-50",
      assigned_user_id: "a",
      starts_at: input.startIso,
      external_id: `burst-${HOLDER}`,
      salesforce_id: `sf-${HOLDER}`,
      attendee_email: `lead${HOLDER}@example.com`,
      attendee_phone: `+1203555${1000 + HOLDER}`,
      manage_token: "tok-held",
      ...over,
    } as Partial<Booking>);
  for (const viaApi of [true, false]) {
    const label = viaApi ? "holder, booking API" : "holder, booker confirm";
    const { runs, tally, bySlot, seatedReads } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i, viaApi ? {} : { refuseIfPersonHasCall: true })),
      pool: ["a"],
      queue: "real",
      viaApi,
      serviceMs: SLOW_MS,
      held: [holding()],
    });
    const want = viaApi ? "deduped" : "EXISTING_CALL";
    assert(runs[HOLDER].outcome === want, `${label}: the lead holding the time is answered ${want} (got ${runs[HOLDER].outcome})`);
    if (viaApi) {
      assert(runs[HOLDER].result?.booking.id === "held-50", `${label}: and is handed the call they hold`);
    }
    const others = runs.filter((_, i) => i !== HOLDER);
    assert(
      others.every((r) => r.outcome === "SLOT_TAKEN"),
      `${label}: everybody else is told SLOT_TAKEN (got ${JSON.stringify(tally)})`,
    );
    assert(bySlot.size === 1, `${label}: nothing new is booked`);
    assert(seatedReads.length === 1, `${label}: who sits at the instant is read once, by the leader (got ${seatedReads.length})`);
    assert(
      quiet(others.slice(1)),
      `${label}: no follower but the holder makes a dependency call`,
    );
    assert(!tally["503"], `${label}: none is answered 503`);
  }

  // --- #3257 review: the #1465 re-tier, a lead holding the time in ANOTHER pool ---
  //
  // Lead 50 holds 13:00 in an old bucket with another advisor, is re-tiered, and
  // confirms 13:00 in the new pool, which the leader fills. The real answer is the
  // #1465 one: they keep the call they hold, and the response says the bucket
  // change was declined because the time is taken. Never a bare SLOT_TAKEN.
  {
    const { runs, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "real",
      serviceMs: SLOW_MS,
      held: [holding({ bucket_id: "bkt-old", assigned_user_id: "z", agent_name: "Agent Z", agent_email: "z@x.com" } as Partial<Booking>)],
    });
    const held = runs[HOLDER];
    const res = held.result as unknown as { outcome?: string; bucketChangeDeclined?: string; booking: Booking } | undefined;
    assert(
      held.outcome === "deduped" && res?.bucketChangeDeclined === "slot_taken" && res.booking.id === "held-50",
      `re-tier: the holder keeps their call and is told the move was declined (got ${held.outcome}, ${res?.bucketChangeDeclined})`,
    );
    assert(runs[0].outcome === "created", "re-tier: the first in is booked into the new pool");
    assert(bySlot.size === 2, "re-tier: the holder's call and the new booking, nothing else");
    assert(
      runs.filter((_, i) => i !== 0 && i !== HOLDER).every((r) => r.outcome === "SLOT_TAKEN") &&
        quiet(runs.filter((_, i) => i !== 0 && i !== HOLDER)),
      "re-tier: the rest are told SLOT_TAKEN without a read",
    );
  }

  // --- #3257 review: an unreadable seat list never answers a holder SLOT_TAKEN ---
  //
  // The leader books and its read of who sits at the instant fails. Without it no
  // follower can be told the time is taken for sure, so the leader hands on rather
  // than settling the slot: the next in line runs for itself, and its own read
  // settles the rest. The holder still hears that it holds the time.
  {
    const { runs, tally, bySlot, seatedReads } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a", "b"],
      queue: "real",
      serviceMs: SLOW_MS,
      held: [holding({ assigned_user_id: "b", agent_name: "Agent B", agent_email: "b@x.com" } as Partial<Booking>)],
      failFirstSeatedRead: true,
    });
    assert(runs[0].outcome === "created", `failed seat read: the leader is booked (got ${runs[0].outcome})`);
    assert(runs[HOLDER].outcome === "deduped", `failed seat read: the holder is answered deduped (got ${runs[HOLDER].outcome})`);
    assert(bySlot.size === 2, "failed seat read: the holder's call and one new booking");
    assert(!tally["503"], `failed seat read: none is answered 503 (got ${JSON.stringify(tally)})`);
    assert(seatedReads.length === 2, `failed seat read: the next leader reads the seats again (got ${seatedReads.length})`);
    // The next leader runs its own chain and is refused by its own read; which
    // confirm that is depends on who looked ahead (#3257), so it is found, not named.
    const taken = runs.filter((r, i) => i !== HOLDER && r.outcome === "SLOT_TAKEN");
    const nextLeader = taken.filter((r) => r.calls.some((c) => !LOOKAHEAD_READS.has(c.name)));
    assert(nextLeader.length === 1, `failed seat read: exactly one refused confirm led again (got ${nextLeader.length})`);
    assert(
      quiet(taken.filter((r) => !nextLeader.includes(r))),
      "failed seat read: the rest are answered without a read beyond the bounded lookahead",
    );
  }

  // --- #3257 review: a slow leader (Google takes 8s) ----------------------------
  //
  // A production confirm answered at 7.4 to 8.0s at the median on 2026-10-04
  // (#3221); it takes about 1.6s now (#3490), and 8s is the slow case the line must
  // still survive. With a fixed 6 second wait every follower gave up first and ran
  // its own chain, which is the stampede again. Followers now wait for the verdict
  // up to their budget less the reserve, so they are answered from it.
  //
  // #3338: the eight seconds are split as the rest of this suite splits a slow
  // confirm, a 3s live check and a 5s calendar write. With all eight in the live
  // check, the leader would reach its commit chain with under 4s left after a Google
  // call that took 8s, and a confirm no longer starts a chain it cannot finish
  // (`commit-cost.ts`); that case is the "slower leader" one below.
  {
    const { runs, tally, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "real",
      slowGoogleMs: 3_000,
      slowEventMs: 5_000,
    });
    assert(runs[0].outcome === "created" && bySlot.size === 1, `slow leader: the first in is booked (got ${runs[0].outcome})`);
    assert(tally.SLOT_TAKEN === BURST - 1, `slow leader: every other one is told SLOT_TAKEN (got ${JSON.stringify(tally)})`);
    assert(quiet(runs.slice(1)), "slow leader: no follower runs a chain of its own");
    assert(
      runs.slice(1).every((r) => r.answeredMs! < BOOKING_CONFIRM_BUDGET_MS),
      "slow leader: every follower is answered inside its budget",
    );
  }

  // --- #3257 review: a leader slower than the wait --------------------------
  //
  // Google takes 10.5s, so the leader answers after the followers' wait runs out.
  // A follower then has only the reserve left, too little for a chain of its own,
  // so it answers the retryable 503 at once and reads nothing: never a stampede.
  //
  // #3338: and the leader itself, with about 1.4s left after a Google call that
  // took 10.5s, no longer starts its reservation, calendar event and insert: it is
  // told to retry with nothing started, rather than being cut off part way and
  // booked later by the drain after being told it failed (L12).
  {
    const { runs, tally, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "real",
      slowGoogleMs: 10_500,
    });
    assert(
      runs[0].outcome === "503" && bySlot.size === 0 && (runs[0].error as DependencyTimeoutError).neededMs !== undefined,
      `slower leader: the first in is told to retry, for want of time to write (got ${runs[0].outcome}, ${String(runs[0].error)})`,
    );
    assert(
      runs[0].calls.every((c) => c.name !== "createEvent" && c.name !== "insertReservation" && c.name !== "commitFreshBooking"),
      "slower leader: it started nothing: no reservation, no event, no save",
    );
    assert(tally["503"] === BURST, `slower leader: the rest are answered the retryable 503 (got ${JSON.stringify(tally)})`);
    assert(quiet(runs.slice(1)), "slower leader: no follower reads beyond the bounded lookahead");
    assert(
      runs.slice(1).every((r) => r.answeredMs === CONFIRM_QUEUE_WAIT_MS),
      `slower leader: each is answered when its wait ends (got ${[...new Set(runs.slice(1).map((r) => r.answeredMs))].join(",")})`,
    );
  }

  // --- #3257 review: ORDINARY traffic for a popular time is not serialised -----
  //
  // Five leads pick 9:00 in a pool of twenty, arriving 1, 2 or 3 seconds apart, at
  // the slow speed (a 3s live check and a 5s calendar write, 8s in all). Each
  // must be booked as fast as the first, on its own advisor, with no insert race
  // lost. Measured before this (the scratch measurement in the PR): on main, and on
  // this branch before the hand on, only the FIRST was booked and the other four
  // were answered 503, because the line held each one behind the 8s confirm ahead
  // of it; with the line switched off they all took the same top advisor and lost
  // the insert race, which at this speed also ran out of budget.
  for (const gapMs of [1_000, 2_000, 3_000]) {
    const label = `ordinary traffic, ${gapMs / 1000}s apart`;
    const { runs, bySlot, raceLosses } = await burst({
      inputs: Array.from({ length: 5 }, (_, i) => lead(i)),
      pool: BIG_POOL,
      queue: "real",
      slowGoogleMs: 3_000,
      slowEventMs: 5_000,
      arriveAtMs: Array.from({ length: 5 }, (_, i) => i * gapMs),
    });
    assert(runs.every((r) => r.outcome === "created"), `${label}: all five are booked (got ${runs.map((r) => r.outcome).join(",")})`);
    const agents = new Set([...bySlot.values()].map((b) => b.assigned_user_id));
    assert(agents.size === 5, `${label}: on five different advisors (got ${agents.size})`);
    assert(raceLosses === 0, `${label}: no confirm lost an insert race to another (got ${raceLosses})`);
    assert(
      runs.every((r) => r.answeredMs! <= runs[0].answeredMs! + 100),
      `${label}: none waited behind another (answered at ${runs.map((r) => r.answeredMs).join(",")}ms)`,
    );
  }

  // --- #3257 review: five at the SAME moment in a big pool, the same answer ----
  {
    const { runs, bySlot, raceLosses } = await burst({
      inputs: Array.from({ length: 5 }, (_, i) => lead(i)),
      pool: BIG_POOL,
      queue: "real",
      slowGoogleMs: 3_000,
      slowEventMs: 5_000,
    });
    assert(runs.every((r) => r.outcome === "created"), `ordinary, together: all five are booked (got ${runs.map((r) => r.outcome).join(",")})`);
    assert(bySlot.size === 5 && raceLosses === 0, `ordinary, together: five advisors, no race lost (got ${bySlot.size}, ${raceLosses})`);
  }

  // --- #3257 review: a crowd at the slow speed still yields the right winners ---
  //
  // A hundred at once for the time, at 8 seconds a confirm (a 3s live check and a
  // 5s calendar write). A pool of two books two and refuses the other 98.
  {
    const { runs, tally, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a", "b"],
      queue: "real",
      slowGoogleMs: 3_000,
      slowEventMs: 5_000,
    });
    assert(
      tally.created === 2 && tally.SLOT_TAKEN === BURST - 2,
      `production crowd, pool of 2: two booked, the rest told SLOT_TAKEN (got ${JSON.stringify(tally)})`,
    );
    assert(bySlot.size === 2, "production crowd, pool of 2: one booking per advisor, never a double");
    // The second booking was made from a pool thinned of the first one's claim. Before
    // #3529 it could not call the slot full (the first might have failed), so one confirm
    // led and read for itself to find nobody left. Now its verdict is full `unlessFreed`:
    // the line knows no claim ended unbooked since the read it decided from, so the other
    // 98 are answered from it and none reads. (When a claim does end unbooked, one confirm
    // reads again: test-confirm-queue.ts, "unless freed control".)
    const readers = runs.filter((r) => r.outcome !== "created" && r.calls.some((c) => !LOOKAHEAD_READS.has(c.name)));
    assert(readers.length === 0, `production crowd, pool of 2: the refused confirms only look ahead, none reads (got ${readers.length})`);
    assert(quiet(runs.filter((r) => r.outcome !== "created" && !readers.includes(r))), "production crowd, pool of 2: the rest stay inside the lookahead bound");
    assert(
      readers.every((r) => r.calls.every((c) => c.name !== "verifyFree" && c.name !== "createEvent")),
      "production crowd, pool of 2: that one never asks Google",
    );
  }

  // A pool of twenty books all twenty. The line hands on once per advisor, each
  // hand on costing one leader's reads up to its candidate read, so the twentieth
  // starts a couple of seconds in and the last booking lands past the 10 second
  // wait. The other 80 cannot honestly be told the time is taken while twenty
  // claims are still in flight (any of them may fail and free its advisor), so they
  // are answered with the retryable 503 when their wait ends, reading nothing.
  {
    const { runs, tally, bySlot, raceLosses } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: BIG_POOL,
      queue: "real",
      slowGoogleMs: 3_000,
      slowEventMs: 5_000,
    });
    assert(tally.created === 20, `production crowd, pool of 20: all twenty advisors are booked (got ${JSON.stringify(tally)})`);
    assert(bySlot.size === 20 && raceLosses === 0, `production crowd, pool of 20: one booking each, no race lost (got ${bySlot.size}, ${raceLosses})`);
    const others = runs.filter((r) => r.outcome !== "created");
    assert(
      others.every((r) => r.outcome === "SLOT_TAKEN" || r.outcome === "503"),
      `production crowd, pool of 20: the rest are told taken or to retry, nothing else (got ${JSON.stringify(tally)})`,
    );
    assert(quiet(others), "production crowd, pool of 20: none of the rest reads beyond the bounded lookahead");
  }

  // --- #3257 review: two confirms that lose a race at once move apart ---------
  //
  // Another isolate has just booked p0 and p1, and the candidate cache has not
  // caught up. Two confirms side by side claim p0 and p1, and both lose the insert
  // race at the same moment. Each must move to an advisor NOBODY in flight has
  // claimed, so neither is handed the other's: two races lost in all, two
  // bookings on two different advisors. Handed to whoever comes next in the
  // round robin, the first one is moved onto p1, which the second has claimed and
  // which is taken anyway, and the pair lose races to each other from there.
  {
    const elsewhere = (id: string, n: number) =>
      makeBooking({
        id: `elsewhere-${id}`,
        assigned_user_id: id,
        starts_at: input.startIso,
        external_id: `other-isolate-${n}`,
        salesforce_id: `sf-other-${n}`,
        attendee_email: `other${n}@example.com`,
        attendee_phone: `+1203557${1000 + n}`,
      } as Partial<Booking>);
    const { runs, bySlot, raceLosses } = await burst({
      inputs: [lead(0), lead(1)],
      pool: BIG_POOL,
      queue: "real",
      heldElsewhere: [elsewhere("p0", 0), elsewhere("p1", 1)],
    });
    assert(runs.every((r) => r.outcome === "created"), `two lost races: both are booked (got ${runs.map((r) => r.outcome).join(",")})`);
    const ours = runs.map((r) => r.result?.booking.assigned_user_id);
    assert(ours[0] !== ours[1], `two lost races: on different advisors (got ${ours.join(",")})`);
    assert(
      ours.every((id) => id !== "p0" && id !== "p1"),
      `two lost races: neither on an advisor another isolate holds (got ${ours.join(",")})`,
    );
    assert(raceLosses === 2, `two lost races: each lost exactly once, never to the other (got ${raceLosses})`);
    assert(bySlot.size === 4, "two lost races: the two held elsewhere and two new bookings");

    // #3489: the same pair with each window between CHOOSING the next advisor and
    // CLAIMING it held open on purpose, so neither depends on when the two confirms
    // happen to lose: a slow rollback of the lost attempt (in production, a calendar
    // event's delete), and a slow live check while the next advisor is being found.
    for (const [label, slow] of [
      ["a slow rollback", { slowCleanupMs: 1_500 }],
      ["a slow live check", { slowGoogleMs: 1_500 }],
    ] as const) {
      const held = await burst({
        inputs: [lead(0), lead(1)],
        pool: BIG_POOL,
        queue: "real",
        heldElsewhere: [elsewhere("p0", 0), elsewhere("p1", 1)],
        ...slow,
      });
      const mine = held.runs.map((r) => r.result?.booking.assigned_user_id);
      assert(
        held.runs.every((r) => r.outcome === "created") && mine[0] !== mine[1] && held.raceLosses === 2,
        `two lost races with ${label}: each lost exactly once and they book apart (got ${held.raceLosses} races lost, ${mine.join(",")})`,
      );
    }
  }

  // --- #3462: a leader that loses the race tells its crowd before it cleans up ---
  //
  // Load run 37566700055, burst 3: another line's leader booked the advisor at
  // about 7s, the `code:121` leader's insert lost to it, and that leader answered
  // only at 12.0s, after rolling back its lost attempt, looking for a next advisor
  // and recording the refusal. Its 41 followers ran out of their wait first and
  // were answered 503. The same shape here: the pool's only advisor is held by a
  // booking the candidate read has not caught up with, the leader runs at the
  // slow speed (a 3.5s live check, a 5s calendar write), and its rollback
  // takes 1.8s, inside the 2s cleanup allowance it runs under. Before the fix the
  // followers' 10 second wait ended before the leader reported and every one of
  // them was answered 503; now every one is told the time is taken before the
  // leader's cleanup has finished.
  {
    const held = makeBooking({
      id: "elsewhere-a",
      assigned_user_id: "a",
      starts_at: input.startIso,
      external_id: "other-line-0",
      salesforce_id: "sf-other-line-0",
      attendee_email: "otherline0@example.com",
      attendee_phone: "+12035580000",
    } as Partial<Booking>);
    const { runs, tally, bySlot, raceLosses, cleanupEndedMs } = await burst({
      inputs: Array.from({ length: 42 }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "real",
      slowGoogleMs: 3_500,
      slowEventMs: 5_000,
      slowCleanupMs: 1_800,
      heldElsewhere: [held],
    });
    assert(raceLosses === 1, `lost race crowd: only the leader reaches the insert, and loses (got ${raceLosses})`);
    assert(bySlot.size === 1, "lost race crowd: nothing is booked beside the booking that won");
    assert(!tally["503"], `lost race crowd: none of the 41 followers is answered 503 (got ${JSON.stringify(tally)})`);
    assert(tally.SLOT_TAKEN === 42, `lost race crowd: the leader and all 41 followers are told the time is taken (got ${JSON.stringify(tally)})`);
    const lastFollower = maxOf(runs.slice(1).map((r) => r.answeredMs!));
    assert(
      cleanupEndedMs !== null && runs.slice(1).every((r) => r.outcome === "SLOT_TAKEN" && r.answeredMs! < cleanupEndedMs),
      `lost race crowd: every follower is told SLOT_TAKEN before the leader's cleanup ends (last follower ${lastFollower}ms, cleanup ended ${cleanupEndedMs}ms)`,
    );
    assert(
      runs[0].answeredMs! < BOOKING_CONFIRM_BUDGET_MS,
      `lost race crowd: the leader itself still answers inside its budget (at ${runs[0].answeredMs}ms)`,
    );
  }

  // --- #3257 review: a claim that FAILED never makes the next booking "full" ----
  //
  // A pool of two. Confirm 0 claims a and hands on; confirm 1 books b from what
  // was left after a's claim. Confirm 0's calendar write then fails (an outage),
  // which frees a. Confirm 1 booked the last advisor of the pool it was SHOWN, but
  // a was never asked by it and is free now, so the confirms waiting behind it must
  // not be told the time is taken: the next one leads and books a.
  {
    const { runs, tally, bySlot } = await burst({
      inputs: Array.from({ length: 5 }, (_, i) => lead(i)),
      pool: ["a", "b"],
      queue: "real",
      slowEventMs: 2_000,
      failFirstEventFor: "a@x.com",
    });
    assert(runs[0].outcome !== "created" && runs[0].outcome !== "SLOT_TAKEN", `failed claim: the first confirm fails with its outage (got ${runs[0].outcome})`);
    const agents = [...bySlot.values()].map((b) => b.assigned_user_id).sort();
    assert(
      JSON.stringify(agents) === JSON.stringify(["a", "b"]),
      `failed claim: the advisor freed by the failure is still booked by somebody waiting (got ${JSON.stringify(agents)}, ${JSON.stringify(tally)})`,
    );
    assert(tally.created === 2, `failed claim: two booked (got ${JSON.stringify(tally)})`);
    assert(!tally["503"], `failed claim: none is answered 503 (got ${JSON.stringify(tally)})`);
  }

  // --- #3257 review: a REPLAY is answered at once, not behind a slow leader ----
  //
  // Lead 7 booked this time on a a moment ago and their client retries the
  // submit. Meanwhile lead 0 is booking the last free advisor, b, at production
  // speed. On main the retry was answered from its idempotency key straight away;
  // queued behind lead 0 it waited about eight seconds. It must be answered at
  // once with the booking it already has, on both paths: the booker by its
  // idempotency key, the booking API by its person decision (a same instant
  // resubmit dedupes).
  for (const viaApi of [false, true]) {
    const label = viaApi ? "replay, booking API" : "replay, booker confirm";
    const replayed = lead(7);
    const theirs = makeBooking({
      id: "booked-7",
      assigned_user_id: "a",
      starts_at: input.startIso,
      external_id: "burst-7",
      salesforce_id: "sf-7",
      attendee_email: "lead7@example.com",
      attendee_phone: `+1203555${1007}`,
      idempotency_key: stableKeyFor(replayed) ?? undefined,
      manage_token: "tok-7",
    } as Partial<Booking>);
    const { runs } = await burst({
      inputs: [lead(0), replayed],
      pool: ["a", "b"],
      queue: "real",
      viaApi,
      slowGoogleMs: 3_000,
      slowEventMs: 5_000,
      held: [theirs],
      arriveAtMs: [0, 1_000],
    });
    const want = viaApi ? "deduped" : "created";
    assert(runs[1].outcome === want, `${label}: answered ${want} (got ${runs[1].outcome})`);
    assert(runs[1].result?.booking.id === "booked-7", `${label}: with the booking it already has`);
    assert(runs[1].answeredMs! < 1_000, `${label}: at once, not behind the confirm booking b (answered at ${runs[1].answeredMs}ms)`);
    assert(runs[0].outcome === "created", `${label}: the confirm booking b is booked (got ${runs[0].outcome})`);
  }

  // --- #3257 review: a crowd of replays still cannot stampede ------------------
  {
    const { runs, calls } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "real",
      viaApi: false,
      serviceMs: SLOW_MS,
    });
    const lookups = runs.filter((r) => r.calls.some((c) => c.name === "findBookingByIdempotencyKey")).length;
    assert(lookups <= 1 + CONFIRM_LINE_LOOKAHEAD, `replay crowd: at most the leader and ${CONFIRM_LINE_LOOKAHEAD} others read their key (got ${lookups})`);
    assert(calls.createEvent.length === 1, "replay crowd: still one winner");
  }

  // --- #3257 review: a lead MOVING their call does not hold up a new booking ----
  //
  // Lead 9 holds 14:00 with p5 and asks the booking API for 13:00, which moves
  // their call in place (a live busy read and an event move, 8s at production
  // speed). Lead 0, unrelated, wants 13:00 in the same pool of twenty and arrives
  // half a second later. Lead 9's move takes one advisor at 13:00, so it claims
  // p5 and hands the line on rather than holding it for the whole move: lead 0 is
  // booked on another advisor as fast as it would be alone.
  {
    const moving = lead(9);
    const theirs = makeBooking({
      id: "booked-9",
      assigned_user_id: "p5",
      agent_email: "p5@x.com",
      starts_at: "2026-06-08T14:00:00.000Z",
      ends_at: "2026-06-08T14:30:00.000Z",
      external_id: "burst-9",
      salesforce_id: "sf-9",
      attendee_email: "lead9@example.com",
      attendee_phone: `+1203555${1009}`,
      manage_token: "tok-9",
      gcal_event_id: "gcal-9",
    } as Partial<Booking>);
    const { runs, bySlot } = await burst({
      inputs: [moving, lead(0)],
      pool: BIG_POOL,
      queue: "real",
      slowGoogleMs: 3_000,
      slowEventMs: 5_000,
      slowRescheduleMs: 8_000,
      held: [theirs],
      existingContext: { booking: theirs, bucket: fakeBucket, eventType: fakeEventType } as BookingContext,
      arriveAtMs: [0, 500],
    });
    assert(runs[0].outcome === "rescheduled", `moving lead: their call is moved (got ${runs[0].outcome})`);
    assert(runs[1].outcome === "created", `moving lead: the unrelated lead is booked (got ${runs[1].outcome})`);
    assert(runs[1].answeredMs! <= 8_400, `moving lead: as fast as alone, not behind the move (answered at ${runs[1].answeredMs}ms)`);
    const newOne = [...bySlot.values()].find((b) => b.id !== "booked-9" && Date.parse(b.starts_at) === Date.parse(input.startIso));
    assert(newOne !== undefined && newOne.assigned_user_id !== "p5", `moving lead: on an advisor other than the one moving in (got ${newOne?.assigned_user_id})`);
  }

  // --- #3257 review: a lookahead that FAILS joins the line as if it found nothing
  //
  // The replay's own lookahead read fails. That read is an optional shortcut, so
  // the confirm must not fail on it: it joins the line, and is answered through
  // it (here, as the lead holding the time, with the booking it already has).
  {
    const replayed = lead(7);
    const key = stableKeyFor(replayed) ?? "";
    const theirs = makeBooking({
      id: "booked-7",
      assigned_user_id: "a",
      starts_at: input.startIso,
      external_id: "burst-7",
      salesforce_id: "sf-7",
      attendee_email: "lead7@example.com",
      attendee_phone: `+1203555${1007}`,
      idempotency_key: key,
      manage_token: "tok-7",
    } as Partial<Booking>);
    const { runs } = await burst({
      inputs: [lead(0), replayed],
      pool: ["a", "b"],
      queue: "real",
      viaApi: false,
      slowGoogleMs: 3_000,
      slowEventMs: 5_000,
      held: [theirs],
      arriveAtMs: [0, 1_000],
      failFirstIdempotencyReadOf: key,
    });
    assert(runs[1].outcome === "created", `failed lookahead: answered through the line, not failed (got ${runs[1].outcome})`);
    assert(runs[1].result?.booking.id === "booked-7", "failed lookahead: with the booking it already has");
    assert(runs[0].outcome === "created", "failed lookahead: the confirm it waited behind is booked");
  }

  // --- #3257 review: a move into the LAST advisor keeps the line ---------------
  //
  // Lead 9 holds 14:00 with a, the pool's only advisor, and moves to 13:00 in
  // place. Five others want 13:00 just after. The move takes the last advisor,
  // so it must not hand the line on: the five wait, and are answered from what is
  // left once it is done, which is nobody. One winner, the move; no new booking.
  {
    const moving = lead(9);
    const theirs = makeBooking({
      id: "booked-9",
      assigned_user_id: "a",
      agent_email: "a@x.com",
      starts_at: "2026-06-08T14:00:00.000Z",
      ends_at: "2026-06-08T14:30:00.000Z",
      external_id: "burst-9",
      salesforce_id: "sf-9",
      attendee_email: "lead9@example.com",
      attendee_phone: `+1203555${1009}`,
      manage_token: "tok-9",
      gcal_event_id: "gcal-9",
    } as Partial<Booking>);
    const { runs, tally, bySlot } = await burst({
      inputs: [moving, ...Array.from({ length: 5 }, (_, i) => lead(i))],
      pool: ["a"],
      queue: "real",
      slowRescheduleMs: 8_000,
      held: [theirs],
      existingContext: { booking: theirs, bucket: fakeBucket, eventType: fakeEventType } as BookingContext,
      arriveAtMs: [0, 200, 200, 200, 200, 200],
    });
    assert(runs[0].outcome === "rescheduled", `last advisor move: the move is made (got ${runs[0].outcome})`);
    assert(
      runs.slice(1).every((r) => r.outcome === "SLOT_TAKEN"),
      `last advisor move: the five are told the time is taken (got ${JSON.stringify(tally)})`,
    );
    assert(bySlot.size === 1, `last advisor move: no new booking beside the move (got ${bySlot.size} rows)`);
  }

  // --- #3338: a crowd behind the TOP rung's last advisor, with free advisors below ---
  //
  // Sales ops decided on 2026-10-02 that a lead whose tier has nobody free at
  // confirm keeps their time with the next tier down, and Dan settled on
  // 2026-10-06 that a confirm in a crowd walks the ladder "Same as a normal
  // confirm". Before this, a leader that booked the last advisor of the rung it
  // booked from told every confirm waiting behind it the time was taken, while the
  // tier below still had people free. 411's ladder is 411, 311, 211; here 411 has
  // one advisor, 311 has three, and 211 has no bucket at all, so the ladder skips it.
  assert(tierLadder(ONE_RUNG).length === 1, `fixture: ${ONE_RUNG} is a one rung ladder (got ${tierLadder(ONE_RUNG).join(",")})`);
  const LADDERED = "411";
  assert(JSON.stringify(tierLadder(LADDERED)) === JSON.stringify(["411", "311", "211"]), `fixture: ${LADDERED} walks 411, 311, 211`);
  const LADDER: Record<string, string[]> = { "411": ["a"], "311": ["c", "d", "e"] };
  const LOWER = LADDER["311"];
  const onLadder = (i: number) => lead(i, { bucketCode: LADDERED });
  // Whether anybody was told the time is taken while an advisor on the rung below
  // was still free: the defect, judged from what was booked when the crowd ended.
  const takenWhileFreeBelow = (tally: Record<string, number>, bySlot: Map<string, Booking>) =>
    (tally.SLOT_TAKEN ?? 0) > 0 && LOWER.some((id) => !bySlot.has(`${id}|${input.startIso}`));
  const lineKinds = [
    { label: "per isolate line", isolates: undefined },
    { label: "shared line", isolates: { count: 10, line: "shared" as const } },
  ];

  // Positive control first (L159): when the rung below has nobody free (its one
  // advisor already holds the time), the crowd still has exactly one winner and
  // everybody else is told the time is taken. What the ladder costs it is ONE hop:
  // the leader booked a rung that is not the ladder's last, so the next confirm in
  // line walks the ladder from the top, finds it spent from the cache alone, and
  // its own refusal settles everybody else. Nobody asks Google or writes anything.
  const cHolds = makeBooking({
    id: "held-c",
    assigned_user_id: "c",
    agent_name: "Agent C",
    agent_email: "c@x.com",
    starts_at: input.startIso,
    external_id: "someone-else",
    salesforce_id: "sf-someone-else",
    attendee_email: "someone@example.com",
    attendee_phone: "+12035569999",
    manage_token: "tok-c",
  } as Partial<Booking>);
  // The save is one recorded call since #3495; the insert inside it is never recorded.
  const WRITES_OR_GOOGLE = new Set(["verifyFree", "createEvent", "insertReservation", "commitFreshBooking"]);
  for (const { label, isolates } of lineKinds) {
    for (const viaApi of [true, false]) {
      const tag = `#3338 control, ${label}, ${viaApi ? "booking API" : "booker confirm"}`;
      const { runs, tally, bySlot } = await burst({
        inputs: Array.from({ length: BURST }, (_, i) => onLadder(i)),
        pool: ["a"],
        poolByCode: { "411": ["a"], "311": ["c"] },
        held: [cHolds],
        queue: "real",
        isolates,
        viaApi,
        slowGoogleMs: 3_000,
        slowEventMs: 5_000,
      });
      assert(tally.created === 1 && bySlot.size === 2, `${tag}: exactly one winner (got ${JSON.stringify(tally)})`);
      assert(tally.SLOT_TAKEN === BURST - 1, `${tag}: everybody else is told the time is taken (got ${JSON.stringify(tally)})`);
      const losers = runs.filter((r) => r.outcome === "SLOT_TAKEN");
      const walkers = losers.filter((r) => r.calls.some((c) => !LOOKAHEAD_READS.has(c.name)));
      assert(walkers.length === 1, `${tag}: one confirm walks the spent ladder, the rest are answered from it (got ${walkers.length})`);
      assert(
        walkers.every((r) => r.calls.every((c) => !WRITES_OR_GOOGLE.has(c.name))),
        `${tag}: that walk asks Google nothing and writes nothing`,
      );
      assert(quiet(losers.filter((r) => !walkers.includes(r))), `${tag}: the rest stay inside the lookahead bound`);
    }
  }

  // The defect, at the slow speed: a second wave of leads arrives five seconds
  // after the first, so the confirm ahead of them finishes inside their budget.
  // Every advisor on the rung below must be booked, by leads who were told before
  // this that the time was taken.
  for (const { label, isolates } of lineKinds) {
    for (const viaApi of [true, false]) {
      const tag = `#3338 second wave, ${label}, ${viaApi ? "booking API" : "booker confirm"}`;
      const { runs, tally, bySlot } = await burst({
        inputs: Array.from({ length: 5 }, (_, i) => onLadder(i)),
        pool: ["a"],
        poolByCode: LADDER,
        queue: "real",
        isolates,
        viaApi,
        slowGoogleMs: 3_000,
        slowEventMs: 5_000,
        arriveAtMs: [0, 5_000, 5_000, 5_000, 5_000],
      });
      assert(runs[0].outcome === "created", `${tag}: the first in books the top rung (got ${runs[0].outcome})`);
      const lower = LOWER.filter((id) => bySlot.has(`${id}|${input.startIso}`));
      assert(
        lower.length === LOWER.length,
        `${tag}: every advisor on the rung below is booked (got ${lower.join(",") || "none"}, ${JSON.stringify(tally)})`,
      );
      assert(!takenWhileFreeBelow(tally, bySlot), `${tag}: nobody is told the time is taken while the rung below has somebody free`);
      const dropped = [...bySlot.values()].filter((b) => (b.routing_trace as { bucket_code?: string } | null)?.bucket_code === "311");
      assert(
        dropped.length === LOWER.length &&
          dropped.every((b) => b.bucket_id === "bkt-311" && (b.routing_trace as { rungs_dropped?: number }).rungs_dropped === 1),
        `${tag}: each booking below names the rung it was made on`,
      );
      // #3338: and says why it dropped, so the branch is counted on /admin/routing
      // (L551): behind the confirms ahead of it in line that booked (`line`), or, since
      // #3489 step 3, past a rung other confirms in flight still held (`claimed`).
      assert(
        dropped.every((b) => ["line", "claimed"].includes(String((b.routing_trace as { dropped_behind?: string }).dropped_behind))),
        `${tag}: each booking below says it dropped behind the line or past claims (got ${dropped.map((b) => (b.routing_trace as { dropped_behind?: string }).dropped_behind).join(",")})`,
      );
      const top = bySlot.get(`a|${input.startIso}`);
      assert(top !== undefined && (top.routing_trace as { dropped_behind?: string }).dropped_behind === undefined, `${tag}: the top rung's booking dropped nothing`);
      assert(
        runs.every((r) => r.outcome === "created" || r.outcome === "SLOT_TAKEN" || r.outcome === "503"),
        `${tag}: every confirm is booked, told the time is taken, or told to retry (got ${JSON.stringify(tally)})`,
      );
    }
  }

  // The same crowd arriving all at once at the slow speed. The confirm ahead
  // holds the line for its whole eight seconds (it is booking the top rung's last
  // advisor, #3257), so those behind it cannot all walk down inside their budget.
  // Dan's rule for that (2026-10-06): they are told to retry, never that the time
  // is taken while the rung below has somebody free (L11).
  for (const { label, isolates } of lineKinds) {
    for (const viaApi of [true, false]) {
      const tag = `#3338 crowd at once, ${label}, ${viaApi ? "booking API" : "booker confirm"}`;
      const { runs, tally, bySlot, heldLines, claimsLeft, reservationsLeftBy } = await burst({
        inputs: Array.from({ length: BURST }, (_, i) => onLadder(i)),
        pool: ["a"],
        poolByCode: LADDER,
        queue: "real",
        isolates,
        viaApi,
        slowGoogleMs: 3_000,
        slowEventMs: 5_000,
      });
      assert(runs[0].outcome === "created", `${tag}: the first in books the top rung (got ${runs[0].outcome})`);
      assert(!takenWhileFreeBelow(tally, bySlot), `${tag}: nobody is told the time is taken while the rung below has somebody free (got ${JSON.stringify(tally)})`);
      assert(
        runs.every((r) => r.outcome === "created" || r.outcome === "SLOT_TAKEN" || r.outcome === "503"),
        `${tag}: every confirm is booked, told the time is taken, or told to retry (got ${JSON.stringify(tally)})`,
      );
      assert(tally.created === bySlot.size, `${tag}: one booking per advisor, never a double`);
      // A lead told to retry must have had nothing started for them (L12): no
      // calendar event and no reservation the drain would later finish into a
      // booking they were told had failed, and no claim left held in the line.
      const retried = runs.filter((r) => r.outcome === "503");
      const wrote = retried.filter((r) => r.calls.some((c) => c.name === "createEvent" || c.name === "insertReservation"));
      assert(wrote.length === 0, `${tag}: no lead told to retry had an event or a reservation started (got ${wrote.length} of ${retried.length})`);
      const left = runs.reduce((n, r) => n + reservationsLeftBy(r), 0);
      assert(left === 0, `${tag}: no reservation is left for the drain (got ${left})`);
      assert(heldLines === 0 && claimsLeft === 0, `${tag}: no line held and no claim left in it (got ${heldLines} held, ${claimsLeft} claims)`);
      console.log(`${tag}: booked ${tally.created ?? 0}, told retry ${tally["503"] ?? 0}, told taken ${tally.SLOT_TAKEN ?? 0}, reservations left ${left}`);
    }
  }

  // #3489 step 3: a walker whose walk STANDS. The ladder holds one free advisor, on its
  // top rung, and the confirm that claims him books before the confirm walking down
  // behind it reaches the bottom: everything the walker skipped has booked, and every
  // rung it read had nobody free. Its own walk proves the ladder spent, so it reports
  // it full and the crowd is refused from that, with the lower rungs read ONCE. Before,
  // the walker parked on nothing, the held verdict was discarded, and the next confirm
  // walked the whole ladder again (2.8s of burst 1 in the load model).
  {
    const LONG = { "500": ["a"], "400": ["c"], "300": ["d"], "200": ["e"] };
    const busy = ["c", "d", "e"].map((id, k) =>
      makeBooking({
        id: `busy-${id}`,
        assigned_user_id: id,
        agent_name: `Agent ${id}`,
        agent_email: `${id}@x.com`,
        starts_at: input.startIso,
        external_id: `already-${k}`,
        salesforce_id: `sf-already-${k}`,
        attendee_email: `already${k}@example.com`,
        attendee_phone: `+1203558${String(1000 + k)}`,
        manage_token: `tok-already-${k}`,
      } as Partial<Booking>),
    );
    const tag = "#3489 step 3, a walk that stands";
    const { tally, runs } = await burst({
      inputs: Array.from({ length: 20 }, (_, i) => lead(i, { bucketCode: "500" })),
      pool: [],
      poolByCode: LONG,
      held: busy,
      queue: "real",
      isolates: { count: 1, line: "shared" },
    });
    assert(tally.created === 1 && tally.SLOT_TAKEN === 19, `${tag}: the one free advisor is booked and everybody else is told the time is taken (got ${JSON.stringify(tally)})`);
    // Every rung a confirm walks to is read through its bucket first, so the bottom
    // rung's bucket reads count the walks that reached the bottom.
    const readsOfBottom = runs
      .flatMap((r) => r.calls)
      .filter((c) => c.name === "resolveBucketByCode" && (c.answer as { bucket?: { code?: string } } | null)?.bucket?.code === "200").length;
    assert(readsOfBottom === 1, `${tag}: the ladder's bottom rung is read by ONE confirm, the walker, never walked again (read ${readsOfBottom} times)`);
  }

  // The same crowd at a speed the line can serve inside the wait (a 1s live check
  // and a 1s calendar write): every advisor on the ladder is booked, and the
  // confirms left once it is spent are told the time is taken.
  for (const { label, isolates } of lineKinds) {
    const tag = `#3338 crowd the line can serve, ${label}`;
    const { tally, bySlot } = await burst({
      inputs: Array.from({ length: 20 }, (_, i) => onLadder(i)),
      pool: ["a"],
      poolByCode: LADDER,
      queue: "real",
      isolates,
      slowGoogleMs: 1_000,
      slowEventMs: 1_000,
    });
    const lower = LOWER.filter((id) => bySlot.has(`${id}|${input.startIso}`));
    assert(
      bySlot.has(`a|${input.startIso}`) && lower.length === LOWER.length,
      `${tag}: the top rung and every advisor below are booked (got ${[...bySlot.keys()].map((k) => k.split("|")[0]).join(",")}, ${JSON.stringify(tally)})`,
    );
    assert(tally.created === 1 + LOWER.length && tally.created === bySlot.size, `${tag}: one booking per advisor, never a double (got ${JSON.stringify(tally)})`);
    assert(!takenWhileFreeBelow(tally, bySlot), `${tag}: nobody is told the time is taken while the rung below has somebody free`);
  }

  // A confirm that LOSES the insert race on a rung's last advisor walks on down
  // too. Two confirms on two isolates, each with its own line (what production
  // runs, `shared_confirm_line` off), both take the top rung's one advisor and race
  // at the insert. The loser goes on to the rung below and books there.
  {
    const { runs, tally, bySlot } = await burst({
      inputs: [onLadder(0), onLadder(1)],
      pool: ["a"],
      poolByCode: LADDER,
      queue: "real",
      isolates: { count: 2, line: "isolate" },
      viaApi: false,
    });
    assert(
      runs.every((r) => r.outcome === "created") && bySlot.has(`a|${input.startIso}`) && bySlot.has(`c|${input.startIso}`),
      `#3338 lost race: both are booked, the loser on the rung below (got ${JSON.stringify(tally)}, ${[...bySlot.keys()].join(",")})`,
    );
    const rescued = runs.find((r) => (r.result?.booking.routing_trace?.race_lost?.length ?? 0) > 0)?.result?.booking;
    assert(
      rescued?.assigned_user_id === "c" &&
        rescued.bucket_id === "bkt-311" &&
        rescued.routing_trace?.bucket_code === "311" &&
        rescued.routing_trace?.rungs_dropped === 1 &&
        JSON.stringify(rescued.routing_trace?.race_lost) === JSON.stringify(["a"]) &&
        rescued.routing_trace?.dropped_behind === "race",
      `#3338 lost race: the loser's booking names the rung below, the advisor it lost above, and that it dropped behind a race (got ${JSON.stringify(rescued?.routing_trace)})`,
    );
  }

  // A lost race never drops a rung for an advisor that was merely CLAIMED (#3257).
  // Confirm 0 claims a and hands on; confirm 1 books b, the only one left unclaimed,
  // and loses the insert race for it to a booking another isolate made. Confirm 0's
  // calendar write then fails, which frees a. Confirm 1 never asked about a (it was
  // claimed when it read the rung), so before it walks down it reads that rung
  // again: a is free now, and it books a on the requested rung rather than dropping.
  {
    const elsewhereB = makeBooking({
      id: "elsewhere-b",
      assigned_user_id: "b",
      agent_name: "Agent B",
      agent_email: "b@x.com",
      starts_at: input.startIso,
      external_id: "other-isolate-b",
      salesforce_id: "sf-other-b",
      attendee_email: "otherb@example.com",
      attendee_phone: "+12035571111",
    } as Partial<Booking>);
    const { runs, bySlot } = await burst({
      inputs: [onLadder(0), onLadder(1)],
      pool: ["a", "b"],
      poolByCode: { "411": ["a", "b"], "311": ["c"] },
      queue: "real",
      viaApi: false,
      heldElsewhere: [elsewhereB],
      slowGoogleMs: 1_000,
      slowEventMs: 2_000,
      failFirstEventFor: "a@x.com",
    });
    assert(runs[0].outcome !== "created", `claimed advisor: confirm 0 fails on its calendar write (got ${runs[0].outcome})`);
    const theirs = runs[1].result?.booking;
    assert(
      runs[1].outcome === "created" && theirs?.assigned_user_id === "a" && theirs.routing_trace?.rungs_dropped === 0,
      `claimed advisor: confirm 1 books the freed advisor on the requested rung, not a rung below (got ${runs[1].outcome}, ${theirs?.assigned_user_id}, dropped ${theirs?.routing_trace?.rungs_dropped})`,
    );
    assert(!bySlot.has(`c|${input.startIso}`), "claimed advisor: nobody is dropped to the rung below");
  }

  // #3529: a booking on the ladder's LAST rung that walked past a rung only because
  // another confirm had claimed it does not prove the slot full. 411 has one advisor
  // (a), 311 no bucket, 211 one advisor (c). Confirm 0 claims a and hands on, since
  // there are rungs below; confirm 1 walks past 411 (a is claimed) and books c on the
  // last rung; confirm 2 waits. Confirm 0's calendar write fails, which frees a, so
  // confirm 2 must book a rather than be told the time is taken. Before the fix
  // confirm 1's booking settled the line as full and refused confirm 2.
  {
    const { runs, tally, bySlot } = await burst({
      inputs: [onLadder(0), onLadder(1), onLadder(2)],
      pool: ["a"],
      poolByCode: { "411": ["a"], "211": ["c"] },
      queue: "real",
      viaApi: false,
      slowGoogleMs: 1_000,
      slowEventMs: 2_000,
      failFirstEventFor: "a@x.com",
    });
    assert(runs[0].outcome !== "created", `past claims: confirm 0 fails on its calendar write (got ${runs[0].outcome})`);
    assert(
      runs[1].outcome === "created" && runs[1].result?.booking.assigned_user_id === "c" && runs[1].result.booking.routing_trace?.dropped_behind === "claimed",
      `past claims: confirm 1 walks past the claimed rung and books c on the last (got ${runs[1].outcome}, ${runs[1].result?.booking.assigned_user_id}, ${runs[1].result?.booking.routing_trace?.dropped_behind})`,
    );
    assert(
      runs[2].outcome === "created" && runs[2].result?.booking.assigned_user_id === "a",
      `past claims: confirm 2 books the freed advisor a, never told the time is taken (got ${runs[2].outcome}, ${runs[2].result?.booking.assigned_user_id}, ${JSON.stringify(tally)})`,
    );
    assert(bySlot.has(`a|${input.startIso}`) && bySlot.has(`c|${input.startIso}`), `past claims: both advisors hold the time (got ${[...bySlot.keys()].join(",")})`);
  }

  // #3529: a crowd whose free advisors sit on all three rungs is handed the WHOLE ladder
  // at once (`ClaimPlace.lower`). Load runs 37857243671 and 37863081340 booked such a crowd
  // in waves, a rung at a time, each wave waiting about two seconds for a walker to claim
  // the rung below. This simulator's walkers do not pay that wait, so the timing is the
  // load model's and the real run's to show; what this pins is that handing the lower rungs
  // out books every free advisor on every rung, each exactly once, and refuses the rest.
  {
    const { runs, tally, bySlot } = await burst({
      inputs: Array.from({ length: 8 }, (_, i) => onLadder(300 + i)),
      pool: ["a"],
      poolByCode: { "411": ["a"], "311": ["c", "d"], "211": ["e", "b"] },
      queue: "real",
      viaApi: false,
      ladderRead: true,
      slowReadsMs: 500,
      slowGoogleMs: 1_000,
      slowEventMs: 2_000,
    });
    const booked = runs.filter((r) => r.outcome === "created").map((r) => r.result?.booking.assigned_user_id).sort();
    assert(JSON.stringify(booked) === JSON.stringify(["a", "b", "c", "d", "e"]) && bySlot.size === 5, `whole ladder: every free advisor on every rung is booked, each once (got ${JSON.stringify(tally)}, ${JSON.stringify(booked)})`);
    assert(tally.SLOT_TAKEN === 3, `whole ladder: the other three are told the time is taken (got ${JSON.stringify(tally)})`);
  }

  // #3529 control (L159): the same crowd where every claim walked past BOOKS. Then the
  // last booking does settle the slot, at once: the line saw no claim end unbooked since
  // confirm 1 read (`unlessFreed`), so the two behind it are told the time is taken
  // without either walking the ladder again to find what the line already knew.
  {
    const { runs, tally } = await burst({
      inputs: [onLadder(0), onLadder(1), onLadder(2), onLadder(3)],
      pool: ["a"],
      poolByCode: { "411": ["a"], "211": ["c"] },
      queue: "real",
      viaApi: false,
      slowGoogleMs: 1_000,
      slowEventMs: 2_000,
    });
    const booked = runs.filter((r) => r.outcome === "created").map((r) => r.result?.booking.assigned_user_id).sort();
    const refused = runs.filter((r) => r.outcome === "SLOT_TAKEN");
    assert(JSON.stringify(booked) === JSON.stringify(["a", "c"]), `past claims, all booked: a and c are booked (got ${JSON.stringify(tally)}, ${JSON.stringify(booked)})`);
    assert(
      refused.length === 2 && quiet(refused),
      `past claims, all booked: the two behind are told the time is taken without walking the ladder (got ${refused.length} refused, calls ${refused.map((r) => r.calls.map((c) => c.name).join(",")).join(" | ")})`,
    );
  }

  // #3529: the same walk past a claimed rung, ending in a LOST RACE on the last rung's
  // only advisor. Nobody is left after c on 211, but the ladder is not spent: a was
  // only claimed, and confirm 0's failed calendar write has since freed it. So confirm
  // 1 waits in the line for that claim (it parks) and books a, rather than being told
  // the time is taken. Before the fix it read "nowhere left to walk" and refused.
  {
    const elsewhereC = makeBooking({
      id: "elsewhere-c",
      assigned_user_id: "c",
      agent_name: "Agent C",
      agent_email: "c@x.com",
      starts_at: input.startIso,
      external_id: "other-isolate-c",
      salesforce_id: "sf-other-c",
      attendee_email: "otherc@example.com",
      attendee_phone: "+12035572222",
    } as Partial<Booking>);
    const { runs, tally, bySlot } = await burst({
      inputs: [onLadder(0), onLadder(1)],
      pool: ["a"],
      poolByCode: { "411": ["a"], "211": ["c"] },
      queue: "real",
      viaApi: false,
      heldElsewhere: [elsewhereC],
      slowGoogleMs: 1_000,
      slowEventMs: 2_000,
      failFirstEventFor: "a@x.com",
    });
    assert(runs[0].outcome !== "created", `past claims, lost race: confirm 0 fails on its calendar write (got ${runs[0].outcome})`);
    assert(
      runs[1].outcome === "created" && runs[1].result?.booking.assigned_user_id === "a",
      `past claims, lost race: confirm 1 books the freed advisor a, never told the time is taken (got ${runs[1].outcome}, ${runs[1].result?.booking.assigned_user_id}, ${JSON.stringify(tally)})`,
    );
    assert(bySlot.has(`a|${input.startIso}`), `past claims, lost race: a holds the time (got ${[...bySlot.keys()].join(",")})`);
  }

  // #3529: load run 37822382352, burst 1. A walker passes a claimed rung, then loses the
  // insert race on the last rung to a booking another line made, and parks. A lost race
  // frees nobody, so once the claim it walked past has booked its
  // walk stands: it refuses, and the two confirms waiting behind it are told the time is
  // taken without either walking the ladder again. Before the fix its lost race moved the
  // line's epoch, the walk could not stand, and a confirm behind it walked the whole ladder
  // (in the run, too late: 95 of the crowd timed out).
  {
    const held = (id: string, who: string): Booking =>
      makeBooking({
        id,
        assigned_user_id: who,
        agent_name: `Agent ${who.toUpperCase()}`,
        agent_email: `${who}@x.com`,
        starts_at: input.startIso,
        external_id: `other-line-${who}`,
        salesforce_id: `sf-other-line-${who}`,
        attendee_email: `otherline${who}@example.com`,
        attendee_phone: who === "c" ? "+12035574441" : "+12035574442",
      } as Partial<Booking>);
    const { runs, tally } = await burst({
      inputs: [onLadder(0), onLadder(1), onLadder(2), onLadder(3)],
      pool: ["a"],
      poolByCode: { "411": ["a"], "211": ["c"] },
      queue: "real",
      viaApi: false,
      heldElsewhere: [held("other-c", "c")],
      slowGoogleMs: 500,
      slowEventMs: 500,
    });
    const booked = runs.filter((r) => r.outcome === "created").map((r) => r.result?.booking.assigned_user_id);
    const refused = runs.filter((r) => r.outcome === "SLOT_TAKEN");
    assert(JSON.stringify(booked) === JSON.stringify(["a"]) && refused.length === 3, `lost races past claims: a is booked and the other three are told the time is taken (got ${JSON.stringify(tally)})`);
    const walker = refused.find((r) => r.calls.some((c) => c.name === "verifyFree"));
    const behind = refused.filter((r) => r !== walker);
    assert(walker !== undefined && behind.length === 2 && quiet(behind), `lost races past claims: the two behind the walker are answered without walking the ladder (got calls ${behind.map((r) => r.calls.map((c) => c.name).join(",")).join(" | ")})`);
  }

  // #3529: a confirm the line HANDS an advisor on a lower rung never read the rungs
  // above it; the leader whose read it was handed may have passed them only for claims.
  // Confirm 0 claims a on 411 and hands on; confirm 1 walks past 411 to 211 and claims
  // c, leaving d for the line. Confirm 2 arrives later and is handed d, whom Google
  // finds busy; by then confirm 1 has booked c, so 211 has nobody. Confirm 0's calendar
  // write failed long before, freeing a. Confirm 2 must park and book a, never be
  // refused: before the fix the rungs it skipped unread counted as spent.
  {
    const { runs, tally, bySlot } = await burst({
      inputs: [onLadder(0), onLadder(1), onLadder(2)],
      pool: ["a"],
      poolByCode: { "411": ["a"], "211": ["c", "d"] },
      queue: "real",
      viaApi: false,
      busyAtGoogle: ["d"],
      arriveAtMs: [0, 0, 2_500],
      slowGoogleMs: 1_000,
      slowEventMs: 2_000,
      failFirstEventFor: "a@x.com",
    });
    assert(runs[0].outcome !== "created", `handed below: confirm 0 fails on its calendar write (got ${runs[0].outcome})`);
    assert(runs[1].outcome === "created" && runs[1].result?.booking.assigned_user_id === "c", `handed below: confirm 1 books c (got ${runs[1].outcome}, ${runs[1].result?.booking.assigned_user_id})`);
    assert(
      runs[2].calls.some((c) => c.name === "verifyFree"),
      "handed below: confirm 2 asked Google about the advisor it was handed",
    );
    assert(
      runs[2].outcome === "created" && runs[2].result?.booking.assigned_user_id === "a",
      `handed below: confirm 2 books the freed advisor a, never told the time is taken (got ${runs[2].outcome}, ${runs[2].result?.booking.assigned_user_id}, ${JSON.stringify(tally)})`,
    );
    assert(!bySlot.has(`d|${input.startIso}`), "handed below: nobody is booked with the advisor Google found busy");
  }

  // #3529: a handed confirm whose handed advisor Google found busy, which then books
  // another on the same rung and loses that race, walks down without asking Google about
  // the handed advisor again. Confirm 0 claims a on a rung of three and hands on; confirm
  // 1 is handed b, whom Google finds busy, so it reads the rung, takes c and loses the
  // insert to a booking another isolate made. Its walk down re-reads that rung, and b
  // must be left out of it as an advisor it already asked.
  {
    const elsewhereC = makeBooking({
      id: "elsewhere-c2",
      assigned_user_id: "c",
      agent_name: "Agent C",
      agent_email: "c@x.com",
      starts_at: input.startIso,
      external_id: "other-isolate-c2",
      salesforce_id: "sf-other-c2",
      attendee_email: "otherc2@example.com",
      attendee_phone: "+12035573333",
    } as Partial<Booking>);
    const { runs, calls } = await burst({
      inputs: [onLadder(0), onLadder(1)],
      pool: ["a", "b", "c"],
      poolByCode: { "411": ["a", "b", "c"] },
      queue: "real",
      viaApi: false,
      heldElsewhere: [elsewhereC],
      busyAtGoogle: ["b"],
      slowGoogleMs: 1_000,
      slowEventMs: 2_000,
    });
    // Every live check, by the emails it asked about. Confirm 0's one check is a wave
    // over its whole rung, the only one naming a; confirm 1 never asks about a (claimed,
    // then booked), so every other check naming b or c is confirm 1's.
    const ownChecks = calls.verifyFree.filter((emails) => !emails.includes("a@x.com"));
    const asksAboutB = ownChecks.filter((emails) => emails.includes("b@x.com")).length;
    const asksAboutC = ownChecks.filter((emails) => emails.includes("c@x.com")).length;
    assert(runs[0].outcome === "created" && runs[0].result?.booking.assigned_user_id === "a", `handed busy: confirm 0 books a (got ${runs[0].outcome})`);
    assert(asksAboutC >= 1, `handed busy: confirm 1 asked about c, the advisor it lost the race on (got ${asksAboutC})`);
    assert(asksAboutB === 1, `handed busy: confirm 1 asked Google about its handed advisor b exactly once (got ${asksAboutB})`);
  }


  // The same race at the slow speed: the attempt that lost took about eight of
  // the twelve seconds, so the loser has too little left to walk down and is told
  // to retry, never that the time is taken while the rung below has somebody free.
  {
    const { runs, tally, bySlot } = await burst({
      inputs: [onLadder(0), onLadder(1)],
      pool: ["a"],
      poolByCode: LADDER,
      queue: "real",
      isolates: { count: 2, line: "isolate" },
      viaApi: false,
      slowGoogleMs: 3_000,
      slowEventMs: 5_000,
    });
    assert(tally.created === 1 && tally["503"] === 1, `#3338 slow lost race: one booked, the loser told to retry (got ${JSON.stringify(tally)})`);
    const loser = runs.find((r) => r.outcome === "503");
    assert(
      loser?.error instanceof DependencyTimeoutError && loser.error.neededMs !== undefined,
      `#3338 slow lost race: the retry says it did not start the walk down for want of time (got ${String(loser?.error)})`,
    );
    assert(!bySlot.has(`c|${input.startIso}`), "#3338 slow lost race: nothing below was booked");
    assert(
      !(loser?.calls ?? []).some((c, i, all) => c.name === "verifyFree" && all.slice(0, i).filter((x) => x.name === "verifyFree").length > 0),
      "#3338 slow lost race: the loser never asks Google about the rung below",
    );
  }

  // --- #3440 and #3441: a leader's refusal settles the line only when its ladder is spent ---
  //
  // Both are the one question `verdictForRefusal` answers: what the confirms waiting
  // behind a refused leader are told. The rule (#3338, Dan 2026-10-06, "Same as a
  // normal confirm") is that they are told the time is taken only when the leader's
  // refusal proves its whole LADDER spent. 311's ladder is 311, 211, 111, and no rung
  // of it is filtered to advisors without Low, so an empty rung is a real empty bucket.
  const LADDER_311 = "311";
  assert(JSON.stringify(tierLadder(LADDER_311)) === JSON.stringify(["311", "211", "111"]), `fixture: ${LADDER_311} walks 311, 211, 111`);
  const someoneHolds = (id: string) =>
    makeBooking({
      id: `held-${id}`,
      assigned_user_id: id,
      agent_name: `Agent ${id}`,
      agent_email: `${id}@x.com`,
      starts_at: input.startIso,
      external_id: `someone-else-${id}`,
      salesforce_id: `sf-someone-else-${id}`,
      attendee_email: `someone-${id}@example.com`,
      attendee_phone: "+12035569999",
      manage_token: `tok-held-${id}`,
    } as Partial<Booking>);

  // #3440: a crowd behind a RESUMED reservation. Lead 0 crashed mid create earlier, and
  // its re-submit resumes the reservation that create wrote, pinned to a, the top rung's
  // only advisor. Somebody else has booked a since. Since #3837 the resume rolls that
  // stale reservation back and walks the ladder like any confirm, so the resumed lead is
  // booked on the rung below, where c and d are free, and nobody behind it is told the
  // time is taken. Before #3440 a taken pin reported a full verdict and the four behind
  // it were turned away; before #3837 the resumed lead itself was.
  {
    const resumed = lead(0, { bucketCode: LADDER_311 });
    const key = stableKeyFor(resumed);
    assert(key !== null, "#3440 fixture: the resumed lead has a stable key, the only kind a reservation is found by");
    const reservation = {
      id: "resv-crashed",
      idempotency_key: key!,
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "slatecrashed",
      payload: {
        booking: {
          org_id: "org1",
          bucket_id: `bkt-${LADDER_311}`,
          event_type_id: "et1",
          assigned_user_id: "a",
          agent_name: "Agent a",
          agent_email: "a@x.com",
          starts_at: input.startIso,
          ends_at: "2026-06-08T13:30:00.000Z",
          original_starts_at: input.startIso,
          original_ends_at: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          status: "confirmed",
          salesforce_id: resumed.salesforceId ?? null,
          attendee_name: resumed.attendee.name,
          attendee_email: resumed.attendee.email,
          attendee_phone: resumed.attendee.phone,
          prefill: {},
          gcal_event_id: "slatecrashed",
          manage_token: "tok-crashed",
          idempotency_key: key!,
          external_id: resumed.externalId ?? null,
          routing_trace: { bucket_code: LADDER_311, bucket_id: `bkt-${LADDER_311}`, considered: ["a"], chosen_user_id: "a", fallback_applied: false },
        },
        event: {
          summary: "Call",
          description: "desc",
          start: input.startIso,
          end: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          attendeeEmail: resumed.attendee.email,
          attendeeName: resumed.attendee.name,
        },
        bucketCode: LADDER_311,
      },
      status: "pending",
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    } as unknown as BookingReservation;
    const below = ["c", "d"];
    for (const viaApi of [true, false]) {
      const tag = `#3440 resumed reservation, ${viaApi ? "booking API" : "booker confirm"}`;
      const { runs, tally, bySlot } = await burst({
        inputs: [resumed, ...Array.from({ length: 4 }, (_, i) => lead(1 + i, { bucketCode: LADDER_311 }))],
        pool: [],
        poolByCode: { [LADDER_311]: ["a"], "211": below },
        held: [someoneHolds("a")],
        inFlight: [reservation],
        queue: "real",
        viaApi,
        // The resume's calendar write is slow, so the four arrive while it leads.
        slowEventMs: 2_000,
        arriveAtMs: [0, 100, 100, 100, 100],
      });
      // #3837 (Dan, 2026-10-16): the resumed lead walks the tiers too, like any confirm.
      // It used to be told its time was taken here while the confirms behind it booked
      // the rung below.
      assert(runs[0].outcome === "created", `${tag}: the resumed lead walks the ladder and is booked (got ${runs[0].outcome})`);
      assert(
        below.includes(String(runs[0].result?.booking.assigned_user_id)),
        `${tag}: with a free advisor on the rung below (got ${runs[0].result?.booking.assigned_user_id})`,
      );
      const names = runs[0].calls.map((c) => c.name);
      assert(
        names.includes("leaseReservation") && names.indexOf("createEvent") >= 0 && names.indexOf("createEvent") < names.indexOf("insertReservation"),
        `${tag}: the fixture really resumed the reservation, under its lease, before walking (got ${names.join(",")})`,
      );
      const bookedBelow = below.filter((id) => bySlot.has(`${id}|${input.startIso}`));
      assert(
        bookedBelow.length === below.length,
        `${tag}: the resumed lead and the confirms behind it book the free advisors on the rung below (got ${bookedBelow.join(",") || "none"}, ${JSON.stringify(tally)})`,
      );
      assert(tally.created === below.length, `${tag}: one booking per free advisor (got ${JSON.stringify(tally)})`);
      assert(
        runs.slice(1).every((r) => r.outcome === "created" || r.outcome === "SLOT_TAKEN"),
        `${tag}: everyone behind is booked or told the time is taken once the ladder is spent (got ${JSON.stringify(tally)})`,
      );
    }

    // #3837: the same resume on a ladder that is genuinely full. The walk is an ordinary
    // walk, so its refusal proves the ladder spent and answers the crowd behind it, as
    // any leader's does (#3440's rule): nobody behind walks the ladder again.
    for (const viaApi of [true, false]) {
      const tag = `#3837 resumed reservation, full ladder, ${viaApi ? "booking API" : "booker confirm"}`;
      const { runs, tally, bySlot } = await burst({
        inputs: [resumed, ...Array.from({ length: 4 }, (_, i) => lead(1 + i, { bucketCode: LADDER_311 }))],
        pool: [],
        poolByCode: { [LADDER_311]: ["a"], "211": ["c"] },
        held: [someoneHolds("a"), someoneHolds("c")],
        inFlight: [reservation],
        queue: "real",
        viaApi,
        slowEventMs: 2_000,
        arriveAtMs: [0, 100, 100, 100, 100],
      });
      assert(bySlot.size === 2 && (tally.created ?? 0) === 0, `${tag}: nobody is booked (got ${JSON.stringify(tally)})`);
      assert(runs.every((r) => r.outcome === "SLOT_TAKEN"), `${tag}: everybody is told the time is taken (got ${JSON.stringify(tally)})`);
      assert(quiet(runs.slice(1)), `${tag}: the crowd is answered from the resumed lead's walk, not by walking again`);
    }
  }

  // #3441: a crowd on a ladder whose LAST rung is an empty bucket. 311's only advisor a
  // is free and 211's only advisor c already holds the time; 111 exists with nobody in
  // it. The first in books a, which is not the ladder's last rung, so it settles
  // nothing. A crowd arriving once it has booked meets no claim in flight (a crowd
  // arriving with it is answered by the #3489 parking instead), so the first of them
  // leads and walks: 311 spent, 211 spent, 111 empty, which ends the walk in
  // `NoEligibleAgentsError` rather than a taken slot. Before the fix that refusal did
  // not settle the line, so every confirm behind it led in turn and walked the whole
  // ladder itself. Now the one walk answers them all, and the walker keeps its own
  // answer, the empty bucket refusal that pages as a misconfigured bucket.
  for (const viaApi of [true, false]) {
    const tag = `#3441 empty last rung, ${viaApi ? "booking API" : "booker confirm"}`;
    const { runs, tally, bySlot, calls } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i, { bucketCode: LADDER_311 })),
      pool: [],
      poolByCode: { [LADDER_311]: ["a"], "211": ["c"], "111": [] },
      held: [someoneHolds("c")],
      queue: "real",
      viaApi,
      slowGoogleMs: 3_000,
      slowEventMs: 5_000,
      arriveAtMs: Array.from({ length: BURST }, (_, i) => (i === 0 ? 0 : 9_000)),
    });
    assert(runs[0].outcome === "created" && tally.created === 1 && bySlot.size === 2, `${tag}: exactly one winner, the first in (got ${JSON.stringify(tally)})`);
    const walkers = runs.filter((r) => r.outcome !== "created" && r.calls.some((c) => !LOOKAHEAD_READS.has(c.name)));
    assert(walkers.length === 1, `${tag}: one confirm walks the spent ladder, the rest are answered from it (got ${walkers.length}, ${JSON.stringify(tally)})`);
    assert(
      walkers[0]?.outcome === "NO_ELIGIBLE_AGENTS",
      `${tag}: the walker keeps its own answer, the empty bucket, so the page is unchanged (got ${walkers[0]?.outcome})`,
    );
    assert(
      calls.recordRoutingDecision.some((d) => d.outcome === "no_eligible_agents"),
      `${tag}: and its refusal is still recorded as an empty bucket`,
    );
    assert(tally.SLOT_TAKEN === BURST - 2, `${tag}: everybody else is told the time is taken (got ${JSON.stringify(tally)})`);
    assert(quiet(runs.filter((r) => r.outcome === "SLOT_TAKEN")), `${tag}: the rest stay inside the lookahead bound`);
  }

  // #3441 control: a ladder with NOBODY in it at all. Every rung is an empty bucket, so
  // no rung refused anybody as taken and there is no taken time to tell anyone about:
  // "taken" would be a claim nothing measured (L11). Each confirm keeps its own empty
  // bucket answer, as before, and a walk of empty rungs asks nobody at Google.
  for (const viaApi of [true, false]) {
    const tag = `#3441 control, nobody on the ladder, ${viaApi ? "booking API" : "booker confirm"}`;
    const { runs, tally, bySlot } = await burst({
      inputs: Array.from({ length: 5 }, (_, i) => lead(i, { bucketCode: LADDER_311 })),
      pool: [],
      poolByCode: { [LADDER_311]: [], "211": [], "111": [] },
      queue: "real",
      viaApi,
    });
    assert(bySlot.size === 0, `${tag}: nobody is booked (got ${bySlot.size})`);
    assert(
      runs.every((r) => r.outcome === "NO_ELIGIBLE_AGENTS"),
      `${tag}: every confirm is answered as an empty bucket, never told the time is taken (got ${JSON.stringify(tally)})`,
    );
  }

  // #3440's rule reaches one more refusal that never walked a ladder: a lead who holds a
  // call and asks the booking API for another time in the same bucket is RESCHEDULED,
  // and that asks only their own bucket (in place, then anybody else in it). Lead 9
  // holds 14:00 with a and asks for 13:00, where Google has a busy and nobody else in
  // 411 is free; c and d on 311 are. Their refusal says nothing about 311, so the four
  // new leads behind them walk down and book there, rather than being told it is taken.
  {
    const tag = "#3440 refused reschedule";
    const theirs = makeBooking({
      id: "booked-9",
      bucket_id: "bkt-411",
      assigned_user_id: "a",
      agent_email: "a@x.com",
      starts_at: "2026-06-08T14:00:00.000Z",
      ends_at: "2026-06-08T14:30:00.000Z",
      external_id: "burst-9",
      salesforce_id: "sf-9",
      attendee_email: "lead9@example.com",
      attendee_phone: `+1203555${1009}`,
      manage_token: "tok-9",
      gcal_event_id: "gcal-9",
    } as Partial<Booking>);
    const below = ["c", "d"];
    const { runs, tally, bySlot } = await burst({
      inputs: [lead(9, { bucketCode: "411" }), ...Array.from({ length: 4 }, (_, i) => lead(i, { bucketCode: "411" }))],
      pool: [],
      poolByCode: { "411": ["a"], "311": below },
      busyAtGoogle: ["a"],
      held: [theirs],
      existingContext: { booking: theirs, bucket: { ...fakeBucket, code: "411", id: "bkt-411" }, eventType: fakeEventType } as BookingContext,
      queue: "real",
      viaApi: true,
      slowRescheduleMs: 2_000,
      arriveAtMs: [0, 100, 100, 100, 100],
    });
    assert(runs[0].outcome === "SLOT_TAKEN", `${tag}: the lead moving their call is refused (got ${runs[0].outcome})`);
    assert(bySlot.get(`a|2026-06-08T14:00:00.000Z`)?.id === "booked-9", `${tag}: and keeps the call they hold`);
    const bookedBelow = below.filter((id) => bySlot.has(`${id}|${input.startIso}`));
    assert(
      bookedBelow.length === below.length && tally.created === below.length,
      `${tag}: the new leads behind it book the free advisors below (got ${bookedBelow.join(",") || "none"}, ${JSON.stringify(tally)})`,
    );
  }

  // #3440 control, the other way: a NAMED LINK's one advisor is its whole ladder, so a
  // leader refused on it still settles everybody behind it. Since #3440 a refusal
  // settles the line only where it is marked as a spent ladder, so this pins that the
  // named link is marked: unmarked, each confirm behind would lead and ask in turn.
  {
    const tag = "#3440 named link, its advisor taken";
    const { runs, tally } = await burst({
      inputs: Array.from({ length: 20 }, (_, i) => lead(i, { bucketCode: LADDER_311, agentLinkUserId: "a" })),
      pool: [],
      poolByCode: { [LADDER_311]: ["a"] },
      held: [someoneHolds("a")],
      queue: "real",
      viaApi: false,
    });
    assert(tally.SLOT_TAKEN === 20, `${tag}: every confirm is told the time is taken (got ${JSON.stringify(tally)})`);
    const askers = runs.filter((r) => r.calls.some((c) => !LOOKAHEAD_READS.has(c.name)));
    assert(askers.length === 1, `${tag}: one confirm asks, the rest are answered from its refusal (got ${askers.length})`);
  }

  // --- #3429: the crowd rule this build DECLARES is the one its confirm path RUNS ---
  //
  // `CONFIRM_CROWD_RULE` is what /api/smoke/version reports and what the load run's
  // judge holds every burst to. A hand set literal enforced by nothing would let #3437
  // change the behaviour and forget the flip, and the judge would then grade every
  // burst against a rule the deployment does not follow (L407). So the REAL confirm
  // path is driven here: a crowd behind a top rung of ONE advisor, with a staffed rung
  // below it, all arriving at once. Under `stops` the leader takes the top rung's last
  // advisor, every confirm waiting behind it is refused as taken, and none books lower
  // (#3338). Under `walks` they walk to the rung below and book there. The outcome must
  // match the declaration, so flipping either one alone fails this suite.
  {
    const top = input.bucketCode;
    const lower = tierLadder(top)[1];
    assert(typeof lower === "string" && lower !== top, `crowd rule: ${top} has a rung below it (got ${lower})`);
    const topPool = ["p0"];
    const lowerPool = ["p1", "p2", "p3", "p4", "p5"];
    const poolByCode = { [top]: topPool, [lower!]: lowerPool };
    /** Which rule a crowd's outcome shows, from where the real path booked it. */
    const ruleShown = (runs: Run[], rows: Map<string, Booking>): ConfirmCrowdRule | string => {
      const advisors = [...rows.values()].map((b) => b.assigned_user_id ?? "");
      const onTop = advisors.filter((id) => topPool.includes(id)).length;
      const below = advisors.filter((id) => lowerPool.includes(id)).length;
      const refused = runs.filter((r) => r.outcome === "SLOT_TAKEN").length;
      if (onTop === 1 && below === 0 && refused === runs.length - 1) return "stops";
      if (onTop === 1 && below === Math.min(lowerPool.length, runs.length - 1)) return "walks";
      return `neither (${onTop} on the top rung, ${below} below, ${refused} SLOT_TAKEN of ${runs.length})`;
    };
    /** The guard itself: null when the outcome shows the declared rule, else why not. */
    const mismatch = (shown: string, declared: ConfirmCrowdRule): string | null =>
      shown === declared ? null : `the confirm path ${shown === "stops" || shown === "walks" ? shown : `shows ${shown}`}, and CONFIRM_CROWD_RULE declares "${declared}"`;

    const crowd = await burst({
      inputs: Array.from({ length: 6 }, (_, i) => lead(200 + i, { bucketCode: top })),
      pool: [],
      poolByCode,
      queue: "real",
    });
    const shown = ruleShown(crowd.runs, crowd.bySlot);
    const why = mismatch(shown, CONFIRM_CROWD_RULE);
    assert(
      why === null,
      `crowd rule: ${why ?? `the crowd's outcome shows "${shown}", the rule CONFIRM_CROWD_RULE declares`} (tally ${JSON.stringify(crowd.tally)})`,
    );

    // Positive controls, one for each half that could change alone (L1).
    // 1. The declaration flipped and the behaviour not: declaring the rule this outcome
    //    does NOT show is refused over it.
    const notShown: ConfirmCrowdRule = shown === "stops" ? "walks" : "stops";
    assert(
      mismatch(shown, notShown) !== null,
      `crowd rule control: declaring "${notShown}" over this outcome is refused (shown ${shown})`,
    );
    // 2. The behaviour different and the declaration not: confirms that never meet in
    //    one crowd each lead and walk the ladder on their own, under either rule, so
    //    the same pools read as walking, and a stops declaration is refused over it.
    const alone = await burst({
      inputs: Array.from({ length: 6 }, (_, i) => lead(210 + i, { bucketCode: top })),
      pool: [],
      poolByCode,
      queue: "real",
      arriveAtMs: [0, 20_000, 40_000, 60_000, 80_000, 100_000],
    });
    const shownAlone = ruleShown(alone.runs, alone.bySlot);
    assert(shownAlone === "walks", `crowd rule control: confirms that never met walk the ladder (got ${shownAlone}, tally ${JSON.stringify(alone.tally)})`);
    assert(mismatch(shownAlone, "stops") !== null, "crowd rule control: and a stops declaration is refused over a walking outcome");
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

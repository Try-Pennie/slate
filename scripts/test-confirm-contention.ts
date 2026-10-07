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
import {
  bookViaApi,
  createBooking,
  timeoutAsRetryable,
  DependencyTimeoutError,
  SlotUnavailableError,
  RaceLostRefusalError,
  ExistingCallError,
  confirmQueueKey,
  queueKeyBeforeRouting,
  stableKeyFor,
  type BookingDeps,
  type CreateBookingInput,
  type BookingResult,
} from "../src/lib/booking/orchestration.ts";
import { withinBookingConfirmBudget, BOOKING_CONFIRM_BUDGET_MS } from "../src/lib/booking/confirm-budget.ts";
import { makeConfirmQueue, isolateLine, CONFIRM_QUEUE_WAIT_MS, CONFIRM_LINE_LOOKAHEAD, type ConfirmLine } from "../src/lib/booking/confirm-queue.ts";
import type { Booking, User } from "../src/lib/db/types.ts";
import type { BookingContext } from "../src/lib/booking/orchestration.ts";
import { createAsserter, makeDeps, makeBooking, input, users, bucket as fakeBucket, eventType as fakeEventType } from "./lib/booking-fakes.ts";
import { VirtualClock, SharedResource, onSharedCapacity, type CallRecord } from "./lib/confirm-contention-sim.ts";
import { makeConfirmLineHost, makeConfirmLineObject } from "../src/lib/booking/confirm-line-object.ts";
import { makeSharedConfirmLine } from "../src/lib/booking/shared-confirm-line.ts";
import { tierLadder } from "../src/lib/routing/tiers.ts";
import { CONFIRM_CROWD_RULE, type ConfirmCrowdRule } from "../src/lib/confirm-crowd-rule.ts";
import { makeCommitCostLog } from "../src/lib/booking/commit-cost.ts";
import { ladderGroupOf } from "../src/lib/booking/line-key.ts";
import { groupingEntriesOf, groupingPutMessage, groupingSnapshotOf, type GroupingSnapshot } from "../src/lib/booking/pool-grouping.ts";
import {
  POOL_GROUPING_FETCH_MS,
  POOL_GROUPING_FRESH_MS,
  POOL_GROUPING_RETRY_MS,
  makeGroupingReader,
  makeGroupingStore,
} from "../src/lib/booking/pool-grouping-reader.ts";
import { groupByPool } from "../src/lib/availability/pool-key.ts";
import { poolGroupingRoster } from "./lib/pool-grouping-fixture.ts";
import { memoryGroupingStorage } from "./lib/memory-grouping-storage.ts";

const { assert, finish } = createAsserter();

/** #3257: a pool of twenty, the size of a popular bucket. */
const BIG_POOL = Array.from({ length: 20 }, (_, i) => `p${i}`);
for (const id of BIG_POOL) (users as Record<string, User>)[id] = { id, name: `Agent ${id}`, email: `${id}@x.com` } as unknown as User;

/** One isolate's share: one unit of work at a time, 12ms each (see the header). */
const CAPACITY = 1;
const SERVICE_MS = 12;
const BURST = 100;
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
      pass: async () => {},
    },
  }),
  lookahead: async () => null,
  release: async () => {},
};

function lead(i: number, over: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    ...input,
    externalId: `burst-${i}`,
    salesforceId: `sf-${i}`,
    attendee: { name: `Lead ${i}`, email: `lead${i}@example.com`, phone: `+1203555${String(1000 + i)}` },
    ...over,
  };
}

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
   * #3429: one pool per rung of the tier ladder, by bucket code, in place of `pool`,
   * so a crowd can meet a shallow top rung with a staffed rung below it. The candidate
   * read leaves out the booked the same way.
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
  /** #3257: how long Google takes to say whether an advisor is free, the slow
   *  part of a production confirm (7.4 to 8.0s at the median, #3221). */
  slowGoogleMs?: number;
  /** How long Google takes to write the advisor's calendar event, the other slow
   *  part, which runs after the advisor is chosen. */
  slowEventMs?: number;
  /** When each confirm arrives, from the first; absent means all at once. */
  arriveAtMs?: number[];
  /** The FIRST calendar write for this advisor's email fails at once, an outage
   *  that ends that confirm and frees the advisor it claimed. */
  failFirstEventFor?: string;
  /** The booking a reschedule loads by its token, for a lead moving their call. */
  existingContext?: BookingContext;
  /** How long Google takes on a reschedule: the live busy read and the event move. */
  slowRescheduleMs?: number;
  /** The FIRST idempotency read for this key fails (a lookahead meeting an outage). */
  failFirstIdempotencyReadOf?: string;
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
}) {
  const clock = new VirtualClock(Date.parse("2026-06-01T00:00:00.000Z"));
  const burstStart = clock.now;
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    const resource = new SharedResource(clock, CAPACITY, opts.serviceMs ?? SERVICE_MS);
    const everyone = [...opts.pool, ...Object.values(opts.poolByCode ?? {}).flat()];
    const { deps: base, calls } = makeDeps({
      candidates: opts.pool,
      // So resolveBucketByCode answers a bucket carrying each rung's own code.
      candidatesByCode: opts.poolByCode,
      freeEmails: new Set(everyone.map((id) => users[id].email)),
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
    const isolateCosts = Array.from({ length: opts.isolates?.count ?? 0 }, () => makeCommitCostLog());
    if (opts.isolates) {
      let ids = 0;
      // One object per line GROUP, as production names them (#3460): a crowd split across
      // `ladder:` and `code:` groups meets several objects, each electing its own leader,
      // which one object shared by every group would hide.
      const hosts = new Map<string, ReturnType<typeof makeConfirmLineHost>>();
      const hostFor = (group: string) => {
        let host = hosts.get(group);
        if (!host) {
          host = makeConfirmLineHost({ now: () => clock.now, timer: timerOnClock, leaseTimer: timerOnClock, newId: () => `o${++ids}` });
          hosts.set(group, host);
        }
        return host;
      };
      for (let k = 0; k < opts.isolates.count; k++) {
        const own = isolateLine(makeConfirmQueue({ timer: timerOnClock, leaseTimer: timerOnClock, now: () => clock.now }));
        isolateLines.push(
          opts.isolates.line === "isolate"
            ? own
            : makeSharedConfirmLine<unknown>({
                // The object is reached in no time at all: the simulation cannot see
                // network latency, which is why the load run measures it (#3325).
                namespace: { stubFor: (group) => ({ send: async (m) => JSON.parse(await hostFor(group).handle(m)) as Record<string, unknown> }) },
                fallback: own,
                enabled: async () => ({ on: true, source: "read" }),
                record: () => {},
                onReachFailure: () => {},
                now: () => clock.now,
                timer: timerOnClock,
                newId: () => `c${++ids}`,
              }),
        );
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
        });
        groupings.push({ lineGroupOf: (code) => ladderGroupOf(code, store.peek), ensure: opts.grouping.fetch ? () => reader.ensure() : null });
      }
    }
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
      roundRobinCandidates: async (b, _e, startMs) => {
        const taken = (id: string) => {
          const slot = `${id}|${new Date(startMs).toISOString()}`;
          return bySlot.has(slot) && !unseen.has(slot);
        };
        const pool = opts.poolByCode ? (opts.poolByCode[b.code] ?? []) : opts.pool;
        return { candidates: pool.filter((id) => !taken(id)), memberCount: pool.length };
      },
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
    opts.inputs.forEach((one, i) => clock.at(t0 + (opts.arriveAtMs?.[i] ?? 0), () => {
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
      const deps = onSharedCapacity(onIsolate, resource, clock, run.calls, SYNCHRONOUS);
      const startedAt = clock.now;
      // #3460: the route awaits the grouping before the line key, as production does.
      const book = opts.viaApi === false ? () => createBooking(one, deps) : () => bookViaApi(one, deps);
      const work = grouping?.ensure ? async () => (await grouping.ensure!(), book()) : book;
      void withinBookingConfirmBudget(work as () => Promise<unknown>).then(
        (res) => {
          run.outcome = (res as { outcome?: string }).outcome ?? "created";
          run.result = res as BookingResult;
          run.answeredMs = clock.now - startedAt;
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
                  : `unexpected ${(err as Error)?.name}: ${(err as Error)?.message}`;
          run.answeredMs = clock.now - startedAt;
        },
      );
    }));
    await clock.runUntil(() => runs.every((r) => r.outcome !== undefined));
    const tally: Record<string, number> = {};
    for (const r of runs) tally[r.outcome!] = (tally[r.outcome!] ?? 0) + 1;
    return { runs, tally, bySlot, calls, seatedReads, raceLosses, cleanupEndedMs: cleanup.endedMs };
  } finally {
    Date.now = realNow;
  }
}

const maxOf = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), 0);

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

async function main() {
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
    const reachedInsert = runs.filter((r) => r.calls.some((c) => c.name === "insertBooking" && c.served)).length;
    assert(reachedInsert === 0, `control: no request got as far as the insert before the budget ran out (got ${reachedInsert})`);
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
  // #3495: the floor was 40 while a booking's save was six database calls after its
  // calendar event. Folded into one, each leader's path is shorter and fewer run out
  // of time (18 of the hundred in this model on 2026-10-07), so the floor is the
  // failure itself, a material share told to retry, rather than the old count.
  {
    const { tally, bySlot } = await burst({
      inputs: Array.from({ length: BURST }, (_, i) => lead(i)),
      pool: ["a"],
      queue: "real",
      isolates: { count: 50, line: "isolate" },
    });
    assert((tally["503"] ?? 0) >= 10, `per isolate lines: leaders are told to retry, the 2026-10-05 failure (got ${JSON.stringify(tally)})`);
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
      const leaders = leadersOf(runs);
      assert(leaders.length === 1, `siblings, snapshot: which elects ONE leader (got ${leaders.length})`);
      assert(tally.created === 1 && bySlot.size === 1, `siblings, snapshot: exactly one confirm is booked (got ${JSON.stringify(tally)})`);
      assert(tally.SLOT_TAKEN === BURST - 1, `siblings, snapshot: and every follower is answered SLOT_TAKEN from it (got ${JSON.stringify(tally)})`);
      assert(!tally["503"], `siblings, snapshot: none is answered 503 (got ${tally["503"] ?? 0})`);
      assert(quiet(runs.filter((r) => r.outcome === "SLOT_TAKEN")), "siblings, snapshot: no follower runs a chain of its own");
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
  {
    const same = lead(7);
    const { runs, bySlot } = await burst({ inputs: [same, same], pool: ["a"], queue: "real", serviceMs: SLOW_MS });
    assert(
      runs.every((r) => r.outcome === "created"),
      `api double submit: both submits get the booking (got ${runs.map((r) => r.outcome).join(",")})`,
    );
    assert(bySlot.size === 1, "api double submit: one booking row");
    assert(Boolean(runs[0].result && runs[1].result), "api double submit: both answered with a booking");
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

  // --- #3257 review: a leader as slow as production (Google takes 8s) -----------
  //
  // A production confirm answers at 7.4 to 8.0s at the median (#3221). With a
  // fixed 6 second wait every follower gave up first and ran its own chain, which
  // is the stampede again. Followers now wait for the verdict up to their budget
  // less the reserve, so they are answered from it.
  //
  // #3338: the eight seconds are split as the rest of this suite splits production
  // speed, a 3s live check and a 5s calendar write. With all eight in the live
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
      runs[0].calls.every((c) => c.name !== "createEvent" && c.name !== "insertReservation" && c.name !== "insertBooking"),
      "slower leader: it started nothing: no reservation, no event, no insert",
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
  // production speed (a 3s live check and a 5s calendar write, 8s in all). Each
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

  // --- #3257 review: a crowd at production speed still yields the right winners -
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
    // The second booking was made from a pool thinned of the first one's claim,
    // so it cannot call the slot full (the first might have failed). Exactly one
    // confirm then leads and reads for itself, finds nobody left without asking
    // Google, and its own verdict answers the other 97 without a read.
    const readers = runs.filter((r) => r.outcome !== "created" && r.calls.some((c) => !LOOKAHEAD_READS.has(c.name)));
    assert(readers.length === 1, `production crowd, pool of 2: one refused confirm leads and reads, the rest only look ahead (got ${readers.length})`);
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
  }

  // --- #3462: a leader that loses the race tells its crowd before it cleans up ---
  //
  // Load run 37566700055, burst 3: another line's leader booked the advisor at
  // about 7s, the `code:121` leader's insert lost to it, and that leader answered
  // only at 12.0s, after rolling back its lost attempt, looking for a next advisor
  // and recording the refusal. Its 41 followers ran out of their wait first and
  // were answered 503. The same shape here: the pool's only advisor is held by a
  // booking the candidate read has not caught up with, the leader runs at
  // production speed (a 3.5s live check, a 5s calendar write), and its rollback
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
      inputs: Array.from({ length: 6 }, (_, i) => lead(200 + i)),
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
      inputs: Array.from({ length: 6 }, (_, i) => lead(210 + i)),
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

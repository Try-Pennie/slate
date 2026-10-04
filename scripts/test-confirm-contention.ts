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
import {
  bookViaApi,
  createBooking,
  timeoutAsRetryable,
  DependencyTimeoutError,
  SlotUnavailableError,
  RaceLostRefusalError,
  confirmQueueKey,
  queueKeyBeforeRouting,
  type BookingDeps,
  type CreateBookingInput,
  type BookingResult,
} from "../src/lib/booking/orchestration.ts";
import { withinBookingConfirmBudget, BOOKING_CONFIRM_BUDGET_MS } from "../src/lib/booking/confirm-budget.ts";
import { makeConfirmQueue, type ConfirmQueue } from "../src/lib/booking/confirm-queue.ts";
import type { Booking } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, input, users } from "./lib/booking-fakes.ts";
import { VirtualClock, SharedResource, onSharedCapacity, type CallRecord } from "./lib/confirm-contention-sim.ts";

const { assert, finish } = createAsserter();

/** One isolate's share: one unit of work at a time, 12ms each (see the header). */
const CAPACITY = 1;
const SERVICE_MS = 12;
const BURST = 100;
/** Not I/O, so they stay synchronous in the wrapped deps. */
const SYNCHRONOUS = new Set(["newManageToken", "newIdempotencyKey", "pageRaceBoundHit", "deferSend", "deadlineTimer", "appBaseUrl"]);

type Outcome = "created" | "SLOT_TAKEN" | "503" | string;
interface Run {
  outcome?: Outcome;
  answeredMs?: number;
  result?: BookingResult;
  error?: unknown;
  calls: CallRecord[];
}

/** A queue that never queues: the behaviour before #3221, for the control. */
const NO_QUEUE: ConfirmQueue<never> = { enter: async () => ({ kind: "unqueued" }) };

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
  queue: "real" | "off";
  viaApi?: boolean;
  /** #3257: how long one dependency call takes on the shared capacity. */
  serviceMs?: number;
  /** #3257: the FIRST person read fails, as a leader meeting an outage would. */
  failFirstPersonRead?: boolean;
}) {
  const clock = new VirtualClock(Date.parse("2026-06-01T00:00:00.000Z"));
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    const resource = new SharedResource(clock, CAPACITY, opts.serviceMs ?? SERVICE_MS);
    const { deps: base, calls } = makeDeps({
      candidates: opts.pool,
      freeEmails: new Set(opts.pool.map((id) => users[id].email)),
    });
    // The bookings table: the active unique index on (agent, start), and the one
    // on the idempotency key a double submit collapses onto.
    const bySlot = new Map<string, Booking>();
    const byKey = new Map<string, Booking>();
    const queue: ConfirmQueue<unknown> =
      opts.queue === "off" ? NO_QUEUE : makeConfirmQueue({ timer: (ms, fire) => clock.at(clock.now + ms, fire) });
    let personReads = 0;
    const shared: BookingDeps = {
      ...base,
      findActiveBookingsForPerson: async (identity, world) => {
        personReads++;
        if (opts.failFirstPersonRead && personReads === 1) throw new Error("bookings read failed");
        return base.findActiveBookingsForPerson(identity, world);
      },
      confirmQueue: queue as BookingDeps["confirmQueue"],
      roundRobinCandidates: async (_b, _e, startMs) => {
        const taken = (id: string) => bySlot.has(`${id}|${new Date(startMs).toISOString()}`);
        return { candidates: opts.pool.filter((id) => !taken(id)), memberCount: opts.pool.length };
      },
      findBookingByIdempotencyKey: async (key) => byKey.get(key) ?? null,
      insertBooking: async (row) => {
        calls.insertBooking.push(row as unknown as Record<string, unknown>);
        const slot = `${row.assigned_user_id}|${row.starts_at}`;
        if (bySlot.has(slot) || byKey.has(String(row.idempotency_key))) return { ok: false, conflict: true };
        const booking = { ...row, id: `bk-${bySlot.size + 1}` } as unknown as Booking;
        bySlot.set(slot, booking);
        byKey.set(String(row.idempotency_key), booking);
        return { ok: true, booking };
      },
    };
    const runs: Run[] = opts.inputs.map(() => ({ calls: [] }));
    opts.inputs.forEach((one, i) => {
      const run = runs[i];
      const deps = onSharedCapacity(shared, resource, clock, run.calls, SYNCHRONOUS);
      const startedAt = clock.now;
      const work = opts.viaApi === false ? () => createBooking(one, deps) : () => bookViaApi(one, deps);
      void withinBookingConfirmBudget(work as () => Promise<unknown>).then(
        (res) => {
          run.outcome = "created";
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
                : `unexpected ${(err as Error)?.name}: ${(err as Error)?.message}`;
          run.answeredMs = clock.now - startedAt;
        },
      );
    });
    await clock.runUntil(() => runs.every((r) => r.outcome !== undefined));
    const tally: Record<string, number> = {};
    for (const r of runs) tally[r.outcome!] = (tally[r.outcome!] ?? 0) + 1;
    return { runs, tally, bySlot, calls };
  } finally {
    Date.now = realNow;
  }
}

const maxOf = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), 0);

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
    assert(runs[0].outcome === "created" && runs[1].outcome === "created", "pool of two: the first two in are the two booked");
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
      readers.length === 0,
      `${label}: no follower reads the bucket, the person or the idempotency key while the leader runs (got ${readers.length})`,
    );
    assert(
      followers.every((r) => r.calls.length === 0),
      `${label}: a refused follower makes no dependency call at all (most made ${maxOf(followers.map((r) => r.calls.length))})`,
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
    assert(runs[1].outcome === "created", `failed leader: the next in line leads and is booked (got ${runs[1].outcome})`);
    assert(tally.created === 1 && bySlot.size === 1, `failed leader: exactly one booking (got ${JSON.stringify(tally)})`);
    assert(tally.SLOT_TAKEN === BURST - 2, `failed leader: the rest are told SLOT_TAKEN (got ${JSON.stringify(tally)})`);
    assert(!tally["503"], `failed leader: none is answered 503 (got ${tally["503"] ?? 0})`);
    assert(
      runs.slice(2).every((r) => r.calls.length === 0),
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
    assert(runs[0].result && runs[1].result, "api double submit: both answered with a booking");
  }

  // --- #3257: where the line can be entered before any read ---------------------
  {
    assert(
      queueKeyBeforeRouting({ bucketCode: "120", startIso: input.startIso }) === confirmQueueKey("120", input.startIso, undefined),
      "early key: a request naming its bucket outright is keyed before any read",
    );
    assert(
      queueKeyBeforeRouting({ bucketCode: "120", startIso: input.startIso, requestedCode: "120" }) ===
        confirmQueueKey("120", input.startIso, undefined),
      "early key: a booker link carrying a routable code is keyed before any read",
    );
    assert(
      queueKeyBeforeRouting({ bucketCode: "120", startIso: input.startIso, agentLinkUserId: "u1" }) ===
        confirmQueueKey("120", input.startIso, "u1"),
      "early key: a named link is keyed on its advisor before any read",
    );
    assert(
      queueKeyBeforeRouting({ bucketCode: "000", startIso: input.startIso, requestedCode: "not-a-code" }) === null,
      "early key: a link Salesforce routes is NOT keyed before routing, since the code it books is not yet known",
    );
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

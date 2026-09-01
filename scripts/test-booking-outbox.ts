// Outbox executor + drain (#429 P2). runOutboxSteps runs each not-`done` step
// idempotently, marks state, and flips the row delivered only when ALL steps are
// done; processBookingOutbox leases each row so the inline path and the drain
// can't both act, runs it, and releases the lease. Driven through in-memory
// fakes — no DB. Run: node --experimental-strip-types scripts/test-booking-outbox.ts
import {
  runOutboxSteps,
  processBookingOutbox,
  everyLeasedRowStoodDown,
  type OutboxHandlers,
} from "../src/lib/booking/outbox.ts";
import type { BookingDeps } from "../src/lib/booking/orchestration.ts";
import type { BookingOutbox, OutboxStep } from "../src/lib/db/types.ts";
import { assert, finish } from "./lib/harness.ts";

function row(steps: OutboxStep[], over: Partial<BookingOutbox> = {}): BookingOutbox {
  return {
    id: "ob-1",
    booking_id: "bk-1",
    action: "cancel",
    status: "pending",
    steps,
    lease_until: null,
    attempts: 0,
    last_error: null,
    created_at: "2026-06-25T00:00:00.000Z",
    updated_at: "2026-06-25T00:00:00.000Z",
    ...over,
  };
}

/** The lease token every write in these fakes is handed. */
const LEASE = "lease-tok";

/**
 * #1048: every write the executor makes is gated on the holder's lease and answers
 * "written", "lease-lost" or "failed". `outcomes` queues answers for successive
 * saves, so a test can put the row into somebody else's hands mid run; the default
 * is "written".
 */
function execDeps(outcomes: ("written" | "lease-lost" | "failed")[] = []) {
  const calls = {
    saves: [] as { id: string; steps: OutboxStep[]; lease: string }[],
    delivered: [] as { id: string; lease: string }[],
  };
  const deps = {
    saveOutboxSteps: async (id: string, steps: OutboxStep[], lease: string) => {
      // snapshot the array (executor mutates it in place)
      calls.saves.push({ id, steps: steps.map((s) => ({ ...s })), lease });
      return outcomes.shift() ?? "written";
    },
    markOutboxDelivered: async (id: string, lease: string) => {
      calls.delivered.push({ id, lease });
      return outcomes.shift() ?? "written";
    },
  } as unknown as BookingDeps;
  return { deps, calls };
}

async function run() {
  // --- runOutboxSteps ---
  {
    // All steps succeed -> delivered, each marked done, handlers ran in order.
    const ran: string[] = [];
    const handlers: OutboxHandlers = {
      a: async () => { ran.push("a"); },
      b: async () => { ran.push("b"); },
    };
    const r = row([
      { name: "a", state: "pending" },
      { name: "b", state: "pending" },
    ]);
    const { deps, calls } = execDeps();
    const res = await runOutboxSteps(deps, r, handlers, LEASE);
    assert(res.delivered === true, "all steps done -> delivered");
    assert(JSON.stringify(ran) === JSON.stringify(["a", "b"]), "runs each step once, in order");
    assert(calls.delivered[0]?.id === "ob-1", "marks the row delivered");
    const lastSave = calls.saves[calls.saves.length - 1];
    assert(
      lastSave.steps.every((s) => s.state === "done"),
      "persists both steps as done",
    );
  }
  {
    // A `done` step is skipped (idempotent resume).
    const ran: string[] = [];
    const handlers: OutboxHandlers = {
      a: async () => { ran.push("a"); },
      b: async () => { ran.push("b"); },
    };
    const r = row([
      { name: "a", state: "done" },
      { name: "b", state: "pending" },
    ]);
    const { deps } = execDeps();
    const res = await runOutboxSteps(deps, r, handlers, LEASE);
    assert(JSON.stringify(ran) === JSON.stringify(["b"]), "skips an already-done step");
    assert(res.delivered === true, "remaining step done -> delivered");
  }
  {
    // A throwing step -> failed, recorded, NOT delivered; later steps still run.
    const ran: string[] = [];
    const handlers: OutboxHandlers = {
      a: async () => { throw new Error("boom"); },
      b: async () => { ran.push("b"); },
    };
    const r = row([
      { name: "a", state: "pending" },
      { name: "b", state: "pending" },
    ]);
    const { deps, calls } = execDeps();
    const res = await runOutboxSteps(deps, r, handlers, LEASE);
    assert(res.delivered === false, "a failed step -> not delivered");
    assert(res.failed.includes("a"), "reports the failed step");
    assert(r.steps[0].state === "failed" && r.steps[0].error === "boom", "marks the step failed + records error");
    assert(ran.includes("b"), "a failed step does not block the others");
    assert(calls.delivered.length === 0, "never marks delivered while a step is unfinished");
  }
  {
    // No handler for a step -> failed (never silently skipped as success).
    const r = row([{ name: "ghost", state: "pending" }]);
    const { deps } = execDeps();
    const res = await runOutboxSteps(deps, r, {});
    assert(res.delivered === false && res.failed.includes("ghost"), "a step with no handler fails, not delivered");
  }

  // --- processBookingOutbox (lease + drain) ---
  {
    // Two pending rows, both leasable, all steps succeed -> both delivered + released.
    const rows = [row([{ name: "a", state: "pending" }], { id: "ob-1" }), row([{ name: "a", state: "pending" }], { id: "ob-2" })];
    const calls = { leased: [] as string[], released: [] as string[], releasedWith: [] as string[], delivered: [] as string[] };
    const handlers: OutboxHandlers = { a: async () => {} };
    const deps = {
      loadDrainableOutbox: async (_limit: number) => rows,
      leaseOutbox: async (id: string) => { calls.leased.push(id); return LEASE; },
      releaseOutboxLease: async (id: string, lease: string) => { calls.released.push(id); calls.releasedWith.push(lease); },
      saveOutboxSteps: async () => "written",
      markOutboxDelivered: async (id: string) => { calls.delivered.push(id); return "written"; },
    } as unknown as BookingDeps;
    const res = await processBookingOutbox(deps, 50, handlers);
    assert(res.processed === 2 && res.delivered === 2, "drains and delivers both rows");
    assert(calls.released.length === 2, "releases the lease for every row it leased");
  }
  {
    // A row already leased by another drain (leaseOutbox false) is skipped.
    const rows = [row([{ name: "a", state: "pending" }], { id: "ob-1" })];
    const handlerRan: string[] = [];
    const handlers: OutboxHandlers = { a: async () => { handlerRan.push("a"); } };
    const deps = {
      loadDrainableOutbox: async () => rows,
      leaseOutbox: async () => null,
      releaseOutboxLease: async () => { throw new Error("should not release a row we never leased"); },
      saveOutboxSteps: async () => "written",
      markOutboxDelivered: async () => "written",
    } as unknown as BookingDeps;
    const res = await processBookingOutbox(deps, 50, handlers);
    assert(res.delivered === 0 && handlerRan.length === 0, "a row leased by another drain is skipped");
  }
  {
    // AUD-062: a backlog drains rows CONCURRENTLY (bounded), not one-at-a-time,
    // so a large backlog clears in far fewer ticks. Each row is still leased
    // independently, so concurrent rows never double-run. Detect concurrency by
    // proving more than one row's handler is in flight at the same moment.
    let inFlight = 0;
    let maxInFlight = 0;
    const handlers: OutboxHandlers = {
      a: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5)); // yield so peers can start
        inFlight--;
      },
    };
    const rows = Array.from({ length: 6 }, (_, i) =>
      row([{ name: "a", state: "pending" }], { id: `ob-c${i}` }),
    );
    const leased: string[] = [];
    const released: string[] = [];
    const deps = {
      loadDrainableOutbox: async () => rows,
      leaseOutbox: async (id: string) => { leased.push(id); return true; },
      releaseOutboxLease: async (id: string) => { released.push(id); },
      saveOutboxSteps: async () => "written",
      markOutboxDelivered: async () => "written",
    } as unknown as BookingDeps;
    const res = await processBookingOutbox(deps, 50, handlers);
    assert(res.delivered === 6, "drains and delivers every backlog row");
    assert(maxInFlight > 1, "drains rows concurrently, not one-at-a-time");
    assert(released.length === 6, "releases the lease for every leased row under concurrency");
  }
  {
    // #445: a failing step is NOT delivered. The row is bumped (attempts + backoff
    // scheduled via the dep) and released; only a row past DRAIN_ALERT_AFTER is
    // reported stuck for the throttled alert.
    const handlers: OutboxHandlers = { a: async () => { throw new Error("boom"); } };
    const bumps: { id: string; attempts: number; error: string }[] = [];
    const released: string[] = [];
    const rows = [
      row([{ name: "a", state: "pending" }], { id: "ob-stuck", attempts: 4 }), // -> 5 = alert
      row([{ name: "a", state: "pending" }], { id: "ob-young", attempts: 0 }), // -> 1 = quiet
    ];
    const deps = {
      loadDrainableOutbox: async () => rows,
      leaseOutbox: async () => LEASE,
      releaseOutboxLease: async (id: string) => { released.push(id); },
      saveOutboxSteps: async () => "written",
      markOutboxDelivered: async () => { throw new Error("must not deliver a row with a failed step"); },
      bumpOutboxAttempt: async (id: string, attempts: number, error: string) => { bumps.push({ id, attempts, error }); },
    } as unknown as BookingDeps;
    const res = await processBookingOutbox(deps, 50, handlers);
    assert(res.delivered === 0, "a row with a failing step is not delivered");
    assert(bumps.length === 2, "every failing row is bumped (attempts incremented, backoff scheduled by the dep)");
    const stuckBump = bumps.find((b) => b.id === "ob-stuck");
    assert(!!stuckBump && stuckBump.attempts === 5, "bump increments the row's prior attempt count");
    assert(!!stuckBump && stuckBump.error.includes("boom"), "bump records the failed step's error");
    assert(res.stuck.length === 1 && res.stuck[0].id === "ob-stuck", "only the row past the alert threshold is reported stuck");
    assert(res.stuck[0]?.attempts === 5, "the reported stuck row carries its bumped attempt count");
    assert(released.length === 2, "both leased rows are released even though they failed");
  }

  // --- #1048: a lease that has moved on stops the run --------------------------
  {
    // Two steps. The save after the first reports the lease is gone, which means a
    // second holder legitimately owns the row and is running these same steps. The
    // run must STAND DOWN: the second step must not run alongside it, and this
    // holder must not declare the row delivered.
    const ran: string[] = [];
    const handlers: OutboxHandlers = {
      a: async () => { ran.push("a"); },
      b: async () => { ran.push("b"); },
    };
    const r = row([
      { name: "a", state: "pending" },
      { name: "b", state: "pending" },
    ]);
    const { deps, calls } = execDeps(["lease-lost"]);
    const res = await runOutboxSteps(deps, r, handlers, LEASE);

    assert(res.stopped === "lease-lost", "a save that lost the lease stops the run, and says why");
    assert(res.delivered === false, "a stood-down run never reports delivered");
    assert(JSON.stringify(ran) === JSON.stringify(["a"]), "the remaining step does not run");
    assert(calls.delivered.length === 0, "and the row is not marked delivered");
  }
  {
    // A write that FAILED is not a lost lease (L11): the row is still ours, the
    // database refused, and the two call for different reactions.
    const handlers: OutboxHandlers = { a: async () => {} };
    const r = row([{ name: "a", state: "pending" }]);
    const { deps } = execDeps(["failed"]);
    const res = await runOutboxSteps(deps, r, handlers, LEASE);

    assert(res.stopped === "write-failed", "a failed write is its own stop reason");
    assert(res.delivered === false, "and is never reported as delivered");
  }
  {
    // The delivery mark is gated too: every step reads done in OUR copy, but the row
    // has a different holder now, so the close must not land.
    const handlers: OutboxHandlers = { a: async () => {} };
    const r = row([{ name: "a", state: "pending" }]);
    // save -> written, markDelivered -> lease-lost
    const { deps } = execDeps(["written", "lease-lost"]);
    const res = await runOutboxSteps(deps, r, handlers, LEASE);

    assert(res.stopped === "lease-lost", "a stale holder cannot close the row");
    assert(res.delivered === false, "and does not claim it did");
  }
  {
    // Every write is handed the token the caller holds. Without this the gating
    // could be present in the store and never actually exercised by the executor.
    const handlers: OutboxHandlers = { a: async () => {} };
    const r = row([{ name: "a", state: "pending" }]);
    const { deps, calls } = execDeps();
    await runOutboxSteps(deps, r, handlers, LEASE);

    assert(
      calls.saves.every((sv) => sv.lease === LEASE),
      "every steps write carries the holder's lease token",
    );
    assert(
      calls.delivered.every((d) => d.lease === LEASE),
      "and so does the delivery mark",
    );
  }
  {
    // The drain's side of it: a row that stood down is counted apart from a row we
    // never leased, and must NOT be charged a failed attempt. Bumping attempts on
    // somebody else's row walks a healthy row toward the give-up cap.
    const rows = [row([{ name: "a", state: "pending" }], { id: "ob-1" })];
    const bumped: string[] = [];
    const handlers: OutboxHandlers = { a: async () => {} };
    const deps = {
      loadDrainableOutbox: async () => rows,
      leaseOutbox: async () => LEASE,
      releaseOutboxLease: async () => {},
      saveOutboxSteps: async () => "lease-lost",
      markOutboxDelivered: async () => "written",
      bumpOutboxAttempt: async (id: string) => { bumped.push(id); },
    } as unknown as BookingDeps;
    const res = await processBookingOutbox(deps, 50, handlers);

    assert(res.handedOff === 1, "the drain counts a stood-down row as handed off");
    assert(res.skipped === 0, "which is NOT the same as a row it never leased");
    assert(res.delivered === 0, "and not a delivery");
    assert(bumped.length === 0, "a handed-off row is charged no failed attempt");
  }
  {
    // The release is handed the token, which is the whole point: an ungated release
    // is what let a stale holder free a live holder's lease.
    const rows = [row([{ name: "a", state: "pending" }], { id: "ob-1" })];
    const calls = { leased: [] as string[], released: [] as string[], releasedWith: [] as string[], delivered: [] as string[] };
    const handlers: OutboxHandlers = { a: async () => {} };
    const deps = {
      loadDrainableOutbox: async () => rows,
      leaseOutbox: async (id: string) => { calls.leased.push(id); return LEASE; },
      releaseOutboxLease: async (id: string, lease: string) => { calls.released.push(id); calls.releasedWith.push(lease); },
      saveOutboxSteps: async () => "written",
      markOutboxDelivered: async () => "written",
    } as unknown as BookingDeps;
    await processBookingOutbox(deps, 50, handlers);

    assert(
      JSON.stringify(calls.releasedWith) === JSON.stringify([LEASE]),
      "the release is gated on the token this holder was given",
    );
  }

  // --- #1048: the tick verdict the alarm and the all-clear both read ------------
  // A stood-down row is charged no failed attempt, so a tick where every leased row
  // stood down can never reach the attempt-cap alert. That makes it its own alarm,
  // and it must not send the attempt-cap alert's all-clear either: a recovery notice
  // off a signal that measured nothing is #1152 exactly. One predicate, so the alarm
  // and the all-clear can never disagree about what happened (L144).
  {
    assert(
      everyLeasedRowStoodDown({ processed: 3, skipped: 0, handedOff: 3 }),
      "every leased row standing down is a stand-down tick",
    );
    assert(
      everyLeasedRowStoodDown({ processed: 5, skipped: 3, handedOff: 2 }),
      "rows leased elsewhere do not count against it: the two we held both stood down",
    );
    assert(
      !everyLeasedRowStoodDown({ processed: 3, skipped: 0, handedOff: 2 }),
      "one row that did NOT stand down means the tick measured delivery",
    );
    assert(
      !everyLeasedRowStoodDown({ processed: 0, skipped: 0, handedOff: 0 }),
      "an empty outbox is not a stand-down, it is the normal quiet state",
    );
    assert(
      !everyLeasedRowStoodDown({ processed: 4, skipped: 4, handedOff: 0 }),
      "a tick that leased nothing at all attempted nothing, so it is not a stand-down",
    );
  }
}

await run();
finish();

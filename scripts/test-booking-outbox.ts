// Outbox executor + drain (#429 P2). runOutboxSteps runs each not-`done` step
// idempotently, marks state, and flips the row delivered only when ALL steps are
// done; processBookingOutbox leases each row so the inline path and the drain
// can't both act, runs it, and releases the lease. Driven through in-memory
// fakes — no DB. Run: node --experimental-strip-types scripts/test-booking-outbox.ts
import {
  runOutboxSteps,
  processBookingOutbox,
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

function execDeps() {
  const calls = {
    saves: [] as { id: string; steps: OutboxStep[] }[],
    delivered: [] as string[],
  };
  const deps = {
    saveOutboxSteps: async (id: string, steps: OutboxStep[]) => {
      // snapshot the array (executor mutates it in place)
      calls.saves.push({ id, steps: steps.map((s) => ({ ...s })) });
    },
    markOutboxDelivered: async (id: string) => {
      calls.delivered.push(id);
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
    const res = await runOutboxSteps(deps, r, handlers);
    assert(res.delivered === true, "all steps done -> delivered");
    assert(JSON.stringify(ran) === JSON.stringify(["a", "b"]), "runs each step once, in order");
    assert(calls.delivered[0] === "ob-1", "marks the row delivered");
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
    const res = await runOutboxSteps(deps, r, handlers);
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
    const res = await runOutboxSteps(deps, r, handlers);
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
    const calls = { leased: [] as string[], released: [] as string[], delivered: [] as string[] };
    const handlers: OutboxHandlers = { a: async () => {} };
    const deps = {
      loadDrainableOutbox: async (_limit: number) => rows,
      leaseOutbox: async (id: string) => { calls.leased.push(id); return true; },
      releaseOutboxLease: async (id: string) => { calls.released.push(id); },
      saveOutboxSteps: async () => {},
      markOutboxDelivered: async (id: string) => { calls.delivered.push(id); },
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
      leaseOutbox: async () => false,
      releaseOutboxLease: async () => { throw new Error("should not release a row we never leased"); },
      saveOutboxSteps: async () => {},
      markOutboxDelivered: async () => {},
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
      saveOutboxSteps: async () => {},
      markOutboxDelivered: async () => {},
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
      leaseOutbox: async () => true,
      releaseOutboxLease: async (id: string) => { released.push(id); },
      saveOutboxSteps: async () => {},
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
}

await run();

finish();

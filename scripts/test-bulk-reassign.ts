// Test for the bulk-reassign engine (#973): the per-item decision state machine
// and the bounded, serialized, idempotent drain loop. Pure-with-fakes → node
// harness (no module mocking). The engine moves an out agent's active upcoming
// bookings one at a time, keying every idempotency decision off the booking's
// CURRENT assignment so a crash-resumed or externally-moved booking is never
// double-moved.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-bulk-reassign.ts
import {
  BULK_REASSIGN_ITEMS_PER_TICK,
  MAX_ITEM_ATTEMPTS,
  drainBulkReassign,
  processBulkReassignItem,
  type BulkReassignDeps,
  type ItemOutcome,
} from "../src/lib/booking/bulk-reassign.ts";
import type { BulkReassignItem, BulkReassignJob } from "../src/lib/db/types.ts";
import { assert, finish } from "./lib/harness.ts";

const job: BulkReassignJob = {
  id: "job1",
  org_id: "org1",
  out_user_id: "out",
  range_start: "2026-07-21T00:00:00.000Z",
  range_end: null,
  reason_code: "coverage",
  reason_detail: null,
  status: "active",
  created_by: "admin1",
  acting_as_user_id: null,
  created_at: "2026-07-21T00:00:00.000Z",
  updated_at: "2026-07-21T00:00:00.000Z",
};

function item(over: Partial<BulkReassignItem> = {}): BulkReassignItem {
  return {
    id: "it1",
    job_id: "job1",
    booking_id: "bk1",
    status: "pending",
    target_user_id: null,
    detail: null,
    attempts: 0,
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
    ...over,
  };
}

// Configurable fake deps with a call log so ordering + idempotency are provable.
function fakeDeps(over: Partial<BulkReassignDeps> = {}) {
  const log: string[] = [];
  const base: BulkReassignDeps = {
    loadPendingItems: async () => [],
    loadBooking: async (id) => ({ id, status: "confirmed", assigned_user_id: "out" }),
    selectTarget: async () => ({ assignment: { userId: "cov", email: "cov@x.com" }, anyUnverified: false }),
    reassign: async (bookingId) => {
      log.push(`reassign:${bookingId}`);
    },
    commitItemOutcome: async (itemId, outcome, attempts) => {
      log.push(`commit:${itemId}:${outcome.status}:${attempts}`);
    },
    markJobDoneIfDrained: async (jobId) => {
      log.push(`done?:${jobId}`);
    },
    ...over,
  };
  return { deps: base, log };
}

async function run() {
  // --- processBulkReassignItem: the per-item state machine ---

  // Happy path: booking still on the out agent, a target is free → moved to it.
  let { deps, log } = fakeDeps();
  let o: ItemOutcome = await processBulkReassignItem(item(), job, deps);
  assert(o.status === "moved" && o.targetUserId === "cov", "a placeable booking is moved onto the covering agent");
  assert(log.includes("reassign:bk1"), "the move calls reassign for the booking");

  // Idempotent: booking already off the out agent (crash-resume / external move)
  // → treated as moved, and reassign is NEVER called again (no double-move).
  ({ deps, log } = fakeDeps({
    loadBooking: async (id) => ({ id, status: "confirmed", assigned_user_id: "someone_else" }),
  }));
  o = await processBulkReassignItem(item(), job, deps);
  assert(o.status === "moved" && o.targetUserId === "someone_else", "a booking already off the out agent is recorded moved");
  assert(!log.some((l) => l.startsWith("reassign")), "a booking already off the out agent is never re-moved (idempotent)");

  // A booking cancelled or completed before we reach it is skipped, not moved.
  for (const status of ["cancelled", "completed"] as const) {
    ({ deps, log } = fakeDeps({
      loadBooking: async (id) => ({ id, status, assigned_user_id: "out" }),
    }));
    o = await processBulkReassignItem(item(), job, deps);
    assert(o.status === "skipped", `a ${status} booking is skipped, not failed`);
    assert(!log.some((l) => l.startsWith("reassign")), `a ${status} booking is never moved`);
  }

  // A booking that no longer exists is skipped.
  ({ deps } = fakeDeps({ loadBooking: async () => null }));
  o = await processBulkReassignItem(item(), job, deps);
  assert(o.status === "skipped", "a missing booking is skipped");

  // No eligible agent free + under cap, and NOT an outage → unplaceable (stays put).
  ({ deps, log } = fakeDeps({
    selectTarget: async () => ({ assignment: null, anyUnverified: false }),
  }));
  o = await processBulkReassignItem(item(), job, deps);
  assert(o.status === "unplaceable", "a genuinely-full slot yields unplaceable");
  assert(!log.some((l) => l.startsWith("reassign")), "an unplaceable booking is not moved");

  // Verify outage (nobody placeable, but a candidate couldn't be checked) → stays
  // pending for retry while attempts remain, then fails once retries are exhausted.
  ({ deps } = fakeDeps({
    selectTarget: async () => ({ assignment: null, anyUnverified: true }),
  }));
  o = await processBulkReassignItem(item({ attempts: 0 }), job, deps);
  assert(o.status === "pending", "a verify outage keeps the item pending for retry");
  o = await processBulkReassignItem(item({ attempts: MAX_ITEM_ATTEMPTS - 1 }), job, deps);
  assert(o.status === "failed", "a verify outage fails once retries are exhausted");

  // A reassign that throws is retried, then fails once retries are exhausted.
  ({ deps } = fakeDeps({
    reassign: async () => {
      throw new Error("cap raced");
    },
  }));
  o = await processBulkReassignItem(item({ attempts: 0 }), job, deps);
  assert(o.status === "pending", "a failed move is retried while attempts remain");
  assert(o.detail?.includes("cap raced") ?? false, "the retry detail carries the underlying error");
  o = await processBulkReassignItem(item({ attempts: MAX_ITEM_ATTEMPTS - 1 }), job, deps);
  assert(o.status === "failed", "a repeatedly-failing move ends as failed, not stuck pending");

  // --- drainBulkReassign: the bounded, serialized, idempotent loop ---

  // Processes each item to completion IN ORDER, one at a time: item 1's move
  // commits before item 2 is even selected, so the daily-cap count item 2 sees
  // already reflects item 1's move (the serialization the cap depends on).
  const items = [
    { item: item({ id: "A", booking_id: "bkA" }), job },
    { item: item({ id: "B", booking_id: "bkB" }), job },
  ];
  ({ deps, log } = fakeDeps({
    loadPendingItems: async () => items,
    selectTarget: async (booking) => {
      log.push(`select:${booking.id}`);
      return { assignment: { userId: "cov", email: "cov@x.com" }, anyUnverified: false };
    },
  }));
  const summary = await drainBulkReassign(deps);
  assert(
    JSON.stringify(log.filter((l) => l.startsWith("select") || l.startsWith("reassign") || l.startsWith("commit:"))) ===
      JSON.stringify(["select:bkA", "reassign:bkA", "commit:A:moved:1", "select:bkB", "reassign:bkB", "commit:B:moved:1"]),
    "items are processed strictly one at a time, in order (select→move→commit before the next item)",
  );
  assert(summary.processed === 2 && summary.moved === 2, "the summary counts every item's outcome");

  // Bounded per tick: the drain asks for at most BULK_REASSIGN_ITEMS_PER_TICK.
  let askedLimit = -1;
  ({ deps } = fakeDeps({
    loadPendingItems: async (limit) => {
      askedLimit = limit;
      return [];
    },
  }));
  await drainBulkReassign(deps);
  assert(askedLimit === BULK_REASSIGN_ITEMS_PER_TICK, "the drain is bounded to a fixed number of items per tick");

  // After a tick, each touched job is checked for completion (marked done when drained).
  ({ deps, log } = fakeDeps({ loadPendingItems: async () => [{ item: item(), job }] }));
  await drainBulkReassign(deps);
  assert(log.includes("done?:job1"), "a touched job is checked for completion after the tick");
}

await run();
finish();

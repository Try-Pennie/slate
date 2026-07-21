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
  buildBulkReassignProgress,
  drainBulkReassign,
  parseBulkReassignRange,
  processBulkReassignItem,
  summarizeBulkReassignItems,
  type ActionableBookingContext,
  type BulkReassignDeps,
  type ItemOutcome,
} from "../src/lib/booking/bulk-reassign.ts";
import type { BulkReassignItem, BulkReassignItemStatus, BulkReassignJob } from "../src/lib/db/types.ts";
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

  // --- summarizeBulkReassignItems: the progress read's counts (#974) ---
  const mk = (status: BulkReassignItemStatus) => ({ status });
  const s = summarizeBulkReassignItems([
    mk("moved"), mk("moved"), mk("unplaceable"), mk("skipped"), mk("failed"), mk("pending"),
  ]);
  assert(s.total === 6, "summary totals every item");
  assert(
    s.counts.moved === 2 && s.counts.unplaceable === 1 && s.counts.skipped === 1 &&
      s.counts.failed === 1 && s.counts.pending === 1,
    "summary counts each status",
  );
  assert(s.done === false, "a job with a pending item is not done");
  assert(summarizeBulkReassignItems([mk("moved"), mk("skipped")]).done === true, "a job with no pending items is done");
  const empty = summarizeBulkReassignItems([]);
  assert(empty.total === 0 && empty.done === true && empty.counts.moved === 0, "an empty job summarizes to zero and done");

  // --- parseBulkReassignRange: endpoint input validation (#974) ---
  const now = "2026-07-21T12:00:00.000Z";
  let pr = parseBulkReassignRange(undefined, undefined, now);
  assert(pr.ok && pr.rangeStart === now && pr.rangeEnd === null, "no range defaults to now onward (open-ended)");
  pr = parseBulkReassignRange("2026-07-25T00:00:00.000Z", null, now);
  assert(pr.ok && pr.rangeEnd === null, "an explicit start with no end is open-ended");
  pr = parseBulkReassignRange("2026-07-25T00:00:00.000Z", "2026-07-28T00:00:00.000Z", now);
  assert(pr.ok && pr.rangeStart === "2026-07-25T00:00:00.000Z" && pr.rangeEnd === "2026-07-28T00:00:00.000Z", "a valid closed range is accepted");
  pr = parseBulkReassignRange("2026-07-28T00:00:00.000Z", "2026-07-25T00:00:00.000Z", now);
  assert(!pr.ok, "an end on/before the start is rejected");
  pr = parseBulkReassignRange("not-a-date", null, now);
  assert(!pr.ok, "an unparseable start is rejected");
  pr = parseBulkReassignRange("2026-07-25T00:00:00.000Z", "also-bad", now);
  assert(!pr.ok, "an unparseable end is rejected");

  // --- buildBulkReassignProgress: the progress composition (#974) ---
  const itemRow = (over: Partial<BulkReassignItem>): BulkReassignItem => item(over);
  const progItems = [
    itemRow({ id: "i1", booking_id: "bkA", status: "moved" }),
    itemRow({ id: "i2", booking_id: "bkB", status: "unplaceable", detail: "no agent free" }),
    itemRow({ id: "i3", booking_id: "bkC", status: "failed", detail: "cap raced" }),
    itemRow({ id: "i4", booking_id: "bkD", status: "skipped" }),
    itemRow({ id: "i5", booking_id: "bkE", status: "pending" }),
  ];
  const ctx = new Map<string, ActionableBookingContext>([
    ["bkB", { startsAt: "2026-07-25T13:00:00.000Z", attendeeName: "Kris" }],
    // bkC intentionally missing → nulls, proving the map is optional per booking.
  ]);
  const prog = buildBulkReassignProgress(job, progItems, ctx);
  assert(prog.job.id === "job1" && prog.summary.total === 5 && prog.summary.done === false, "progress carries the job and full summary");
  assert(
    prog.actionable.length === 2 && prog.actionable.every((a) => a.status === "unplaceable" || a.status === "failed"),
    "only unplaceable + failed items are actionable (the ones still on the out agent)",
  );
  const byId = Object.fromEntries(prog.actionable.map((a) => [a.bookingId, a]));
  assert(
    byId.bkB.startsAt === "2026-07-25T13:00:00.000Z" && byId.bkB.attendeeName === "Kris" && byId.bkB.detail === "no agent free",
    "an actionable item is enriched with its booking context + detail",
  );
  assert(
    byId.bkC.startsAt === null && byId.bkC.attendeeName === null,
    "an actionable item with no context row degrades to null display fields, not a crash",
  );
}

await run();
finish();

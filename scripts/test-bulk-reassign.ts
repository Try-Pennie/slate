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
  drainOneJob,
  isBulkReassignProgress,
  drainBulkReassign,
  parseBulkReassignRange,
  processBulkReassignItem,
  summarizeBulkReassignItems,
  type ActionableBookingContext,
  type BulkReassignDeps,
  type ItemOutcome,
} from "../src/lib/booking/bulk-reassign.ts";
import type { BulkReassignItem, BulkReassignItemStatus, BulkReassignJob } from "../src/lib/db/types.ts";
import type { AuditEntry } from "../src/lib/audit.ts";
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
    claimItem: async () => true,
    recordAudit: async () => {},
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

  // #3485 Part 1: a pick on a lower rung of the tier ladder is handed to the reassign with
  // its placement, so the move lands in that rung's bucket; a pick in the booking's own
  // bucket is handed none, so it stays a plain reassign.
  {
    const placement = { bucket: { id: "b111", code: "111" }, eventType: { id: "et1" }, rungsDropped: 1 } as never;
    const seen: unknown[] = [];
    const cascaded = fakeDeps({
      selectTarget: async () => ({ assignment: { userId: "low", email: "low@x.com" }, anyUnverified: false, placement }),
      reassign: async (_id, _email, _job, p) => {
        seen.push(p);
      },
    });
    const out = await processBulkReassignItem(item(), job, cascaded.deps);
    assert(out.status === "moved" && out.targetUserId === "low", "a pick on a lower rung is moved like any other");
    assert(seen.length === 1 && seen[0] === placement, "and the reassign is handed its placement");
    const plain: unknown[] = [];
    await processBulkReassignItem(item(), job, fakeDeps({ reassign: async (_id, _email, _job, p) => void plain.push(p) }).deps);
    assert(plain.length === 1 && plain[0] === undefined, "a pick in the booking's own bucket is handed no placement");
  }

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
  // #3485: the detail must not blame the daily cap. Most event types carry no cap
  // (it is null), so "nobody was free and under their daily cap" names a gate that
  // never applied and sent a reader down the wrong path. It says availability, the
  // one thing always true when a slot is genuinely full.
  assert(!/daily cap/i.test(o.detail ?? ""), "the unplaceable detail does not blame the daily cap");
  assert(
    /no other advisor was available/i.test(o.detail ?? ""),
    "the unplaceable detail says no other advisor was available",
  );
  assert(!/gap|kept clear/i.test(o.detail ?? ""), "and blames no gap it did not measure");

  // #3485: when the measured reason is the gap kept clear around the call, the detail says
  // so, with the count, because placing it by hand then means a call back to back.
  {
    const gap = fakeDeps({
      selectTarget: async () => ({ assignment: null, anyUnverified: false, gapOnly: { advisors: 3, beforeMin: 10, afterMin: 10 } }),
    });
    const out = await processBulkReassignItem(item(), job, gap.deps);
    assert(out.status === "unplaceable", "a call blocked only by the gap is still unplaceable");
    assert(
      out.detail ===
        "No other advisor was available to take this appointment at its original time. 3 advisors were free for the call itself, but not for the 10 minutes kept clear before and after it.",
      `and the detail names the gap and the count (got ${out.detail})`,
    );
    const one = await processBulkReassignItem(item(), job, fakeDeps({
      selectTarget: async () => ({ assignment: null, anyUnverified: false, gapOnly: { advisors: 1, beforeMin: 0, afterMin: 10 } }),
    }).deps);
    assert(
      /1 advisor was free for the call itself, but not for the 10 minutes kept clear after it\.$/.test(one.detail ?? ""),
      `one advisor and a gap on one side read correctly (got ${one.detail})`,
    );
  }

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

  // #3120: the per item claim is not exclusive and relies on the lane lock, so a run
  // that has lost the lock must not start another item: two runs would pick targets
  // against the same daily cap count and overload a covering agent. The fence is
  // asked before each CLAIM, and a lost lease stops the drain where it stands.
  {
    let asks = 0;
    ({ deps, log } = fakeDeps({
      loadPendingItems: async () => [
        { item: item({ id: "A", booking_id: "bkA" }), job },
        { item: item({ id: "B", booking_id: "bkB" }), job },
      ],
    }));
    const fenced = await drainBulkReassign(deps, BULK_REASSIGN_ITEMS_PER_TICK, async () => ++asks < 2);
    assert(log.includes("reassign:bkA"), "lease held: the first item is moved");
    assert(!log.includes("reassign:bkB"), "lease lost: the next item is not started");
    assert(fenced.processed === 1, "lease lost: only the item started under the lease is counted");
    assert(asks === 2, "the fence is asked once per item, before it is claimed");
  }

  // After a tick, each touched job is checked for completion (marked done when drained).
  ({ deps, log } = fakeDeps({ loadPendingItems: async () => [{ item: item(), job }] }));
  await drainBulkReassign(deps);
  assert(log.includes("done?:job1"), "a touched job is checked for completion after the tick");

  // Partial batch (#975): one tick produces moved + unplaceable + skipped + failed
  // together, and the summary reflects every outcome.
  const mixed = [
    { item: item({ id: "A", booking_id: "bkA" }), job }, // on out, placeable -> moved
    { item: item({ id: "B", booking_id: "bkB" }), job }, // no target, not outage -> unplaceable
    { item: item({ id: "C", booking_id: "bkC" }), job }, // cancelled -> skipped
    { item: item({ id: "D", booking_id: "bkD", attempts: MAX_ITEM_ATTEMPTS - 1 }), job }, // reassign errors, last try -> failed
  ];
  ({ deps } = fakeDeps({
    loadPendingItems: async () => mixed,
    loadBooking: async (id) =>
      id === "bkC"
        ? { id, status: "cancelled", assigned_user_id: "out" }
        : { id, status: "confirmed", assigned_user_id: "out" },
    selectTarget: async (booking) =>
      booking.id === "bkB"
        ? { assignment: null, anyUnverified: false }
        : { assignment: { userId: "cov", email: "cov@x.com" }, anyUnverified: false },
    reassign: async (bookingId) => {
      if (bookingId === "bkD") throw new Error("cap raced");
    },
  }));
  const mixedSummary = await drainBulkReassign(deps);
  assert(
    mixedSummary.processed === 4 &&
      mixedSummary.moved === 1 &&
      mixedSummary.unplaceable === 1 &&
      mixedSummary.skipped === 1 &&
      mixedSummary.failed === 1,
    "a mixed batch yields one of each outcome and the summary counts them all (#975)",
  );

  // Idempotent re-run (#975): a booking moved on the first tick, then re-processed
  // on a later tick (the item was left pending by a crash before commit), is
  // recorded moved from its assignment and NEVER reassigned a second time.
  let assignedTo = "out";
  const reassignCalls: string[] = [];
  const rerunDeps: BulkReassignDeps = {
    loadPendingItems: async () => [{ item: item({ id: "R", booking_id: "bkR" }), job }],
    loadBooking: async (id) => ({ id, status: "confirmed", assigned_user_id: assignedTo }),
    selectTarget: async () => ({ assignment: { userId: "cov", email: "cov@x.com" }, anyUnverified: false }),
    reassign: async (bookingId) => {
      reassignCalls.push(bookingId);
      assignedTo = "cov"; // the swap committed: the booking is now off the out agent
    },
    claimItem: async () => true,
    commitItemOutcome: async () => {},
    markJobDoneIfDrained: async () => {},
  };
  const first = await drainBulkReassign(rerunDeps);
  const second = await drainBulkReassign(rerunDeps);
  assert(first.moved === 1 && second.moved === 1, "both the first move and the re-run record the item moved");
  assert(reassignCalls.length === 1, "a re-run never reassigns an already-moved booking a second time (idempotent)");

  // --- a sweep that was STOPPED (#1665) ---
  //
  // Two guards, and they cover different moments. The job status covers a tick that
  // starts after the cancellation; the claim covers a tick already part way through
  // a batch it read before it. Each is asserted beside the same fixture WITHOUT the
  // stop, so neither can pass because the fixture could not have moved anything.
  {
    const stoppedJob: BulkReassignJob = { ...job, status: "cancelled" };
    const f = fakeDeps();
    const outcome = await processBulkReassignItem(item(), stoppedJob, f.deps);
    assert(outcome.status === "cancelled", "an item of a stopped sweep is refused rather than moved");
    assert(
      f.log.length === 0,
      "and refused before any work: no booking read, no target selected, no reassign",
    );
    assert((outcome.detail ?? "").length > 0, "the row says why it never moved");

    // CONTROL: the same item under the same sweep, still active, moves.
    const control = await processBulkReassignItem(item(), job, fakeDeps().deps);
    assert(control.status === "moved", "CONTROL: the same item under a live sweep is moved");
  }
  {
    // The row was stopped between this tick reading its batch and reaching the item.
    const claimed: string[] = [];
    const f = fakeDeps({
      loadPendingItems: async () => [{ item: item({ id: "C", booking_id: "bkC" }), job }],
      claimItem: async (id) => {
        claimed.push(id);
        return false;
      },
    });
    const summary = await drainBulkReassign(f.deps);
    assert(claimed.length === 1, "the tick asked the store whether the row was still pending");
    assert(summary.unclaimed === 1 && summary.processed === 0, "a row it could not claim is not processed");
    assert(
      !f.log.some((l) => l.startsWith("reassign:")) && !f.log.some((l) => l.startsWith("commit:")),
      "nothing is moved and nothing is written over whatever the other writer set",
    );
    assert(f.log.includes("done?:job1"), "the job is still checked for completion, so it cannot be stranded active");

    // CONTROL: the identical tick whose claim succeeds does move it.
    const c = fakeDeps({
      loadPendingItems: async () => [{ item: item({ id: "C", booking_id: "bkC" }), job }],
    });
    const cs = await drainBulkReassign(c.deps);
    assert(cs.moved === 1, "CONTROL: the same tick with the row still pending moves it");
  }

  // --- summarizeBulkReassignItems: the progress read's counts (#974) ---
  const mk = (status: BulkReassignItemStatus) => ({ status });
  const s = summarizeBulkReassignItems([
    mk("moved"), mk("moved"), mk("unplaceable"), mk("skipped"), mk("failed"), mk("pending"),
    mk("cancelled"),
  ]);
  assert(s.total === 7, "summary totals every item");
  assert(s.counts.cancelled === 1, "an appointment a stopped sweep never moved is counted as its own outcome (#1665)");
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

  // #2122: the SKIPPED items come back too, as their own list.
  //
  // Dan, meeting a count of 1 with nothing beside it: "now it says nothing about
  // the skipped one. what am I supposed to do about that". The answer is nothing,
  // and that is precisely why the count alone was unreadable: a number with no
  // consequence is a fact the reader has to work out. Every skip this engine
  // writes carries its own detail ("Booking no longer exists", "Booking was
  // cancelled before it could be moved"), so the panel can say which and why.
  //
  // They are a SEPARATE list from `actionable` and not merged into it, because
  // actionable means a person still has to place it by hand and a skip means
  // nobody has to do anything. Merging them would be the same conflation the mark
  // had, where a skip was drawn as a failure.
  assert(
    prog.skipped.length === 1 && prog.skipped[0]!.bookingId === "bkD",
    "the skipped items come back as their own list",
  );
  assert(
    !prog.actionable.some((a) => a.status === "skipped"),
    "and a skip is never in the actionable list, because nobody has to place it",
  );
  assert(
    prog.skipped[0]!.startsAt === null && prog.skipped[0]!.attendeeName === null,
    "a skipped item with no context row degrades to null display fields too",
  );

  // With context, it reads like an actionable row does: same shape, so the panel
  // renders both from one row component rather than two that drift.
  const ctx2 = new Map<string, ActionableBookingContext>([
    ["bkD", { startsAt: "2026-07-26T09:00:00.000Z", attendeeName: "Alex" }],
  ]);
  const prog2 = buildBulkReassignProgress(job, progItems, ctx2);
  assert(
    prog2.skipped[0]!.attendeeName === "Alex" && prog2.skipped[0]!.startsAt === "2026-07-26T09:00:00.000Z",
    "a skipped item is enriched from the same context map",
  );

  // Nothing skipped is an EMPTY list, never absent: a caller mapping over it must
  // not have to guard, and an absent field would read as "could not tell".
  const progNone = buildBulkReassignProgress(job, [itemRow({ id: "x", booking_id: "bkZ", status: "moved" })], new Map());
  assert(Array.isArray(progNone.skipped) && progNone.skipped.length === 0, "no skips is an empty list");

  // #3615: a DEMOTION sweep also lists the calls it moved, each a link to the booking where the
  // move back lives. Nothing else told a person which calls an automatic reroute moved. Any other
  // sweep lists none: its moves were asked for by the person watching.
  const demotion = { ...job, created_by: null, demotion_marked_at: "2026-10-11T18:00:00.000Z", demotion_change: null };
  const ctxMoved = new Map([["bkA", { startsAt: "2026-10-14T15:00:00.000Z", attendeeName: "Ann" }]]);
  const progDemotion = buildBulkReassignProgress(demotion, [itemRow({ id: "m1", booking_id: "bkA", status: "moved" }), itemRow({ id: "m2", booking_id: "bkB", status: "unplaceable" })], ctxMoved);
  assert(progDemotion.moved.length === 1 && progDemotion.moved[0].bookingId === "bkA", "a demotion sweep lists the call it moved");
  assert(progDemotion.moved[0].attendeeName === "Ann", "with the lead's name to recognise it by");
  assert(progNone.moved.length === 0, "any other sweep lists no moved calls");
  assert(isBulkReassignProgress(progDemotion), "the payload with moved calls is a valid progress reply");
  const { moved: _drop, ...older } = progDemotion;
  assert(isBulkReassignProgress(older), "a reply from a server older than the moved list still reads (L598)");
  assert(!isBulkReassignProgress({ ...progDemotion, moved: "x" }), "a moved list of the wrong shape is refused");
  // A call an admin already moved back says so on its row, so the list never offers it again.
  const progBack = buildBulkReassignProgress(
    demotion,
    [itemRow({ id: "m1", booking_id: "bkA", status: "moved", reverted_at: "2026-10-12T14:00:00.000Z" })],
    ctxMoved,
  );
  assert(progBack.moved?.[0].revertedAt === "2026-10-12T14:00:00.000Z", "a moved back call carries when it went back");
  assert(isBulkReassignProgress(progBack), "and the reply carrying it is valid");
  assert(!isBulkReassignProgress({ ...progBack, moved: [{ ...progBack.moved![0], revertedAt: 7 }] }), "a reverted stamp of the wrong type is refused");

  // Whether each moved call can STILL go back, judged by the same planner the booking page uses
  // (L1007: the row may only offer what the rules permit now).
  {
    const NOWMS = Date.parse("2026-10-12T15:00:00.000Z");
    const ctxFor = (status: string, assignedUserId: string | null, startsAt = "2026-10-14T15:00:00.000Z") =>
      new Map([["bkA", { startsAt, attendeeName: "Ann", status, assignedUserId }]]);
    const movedItem = [itemRow({ id: "m1", booking_id: "bkA", status: "moved", target_user_id: "cov" })];
    const original = { email: "out@x.com", deactivated_at: null };
    const can = (ctx: ReturnType<typeof ctxFor>, orig: typeof original | null = original) =>
      buildBulkReassignProgress(demotion, movedItem, ctx, { original: orig, nowMs: NOWMS }).moved?.[0].canMoveBack;
    assert(can(ctxFor("confirmed", "cov")) === true, "a call still with the advisor it moved to can go back");
    assert(can(ctxFor("cancelled", "cov")) === false, "a cancelled one cannot");
    assert(can(ctxFor("confirmed", "someone-else")) === false, "nor one moved again since");
    assert(can(ctxFor("confirmed", "cov", "2026-10-12T14:00:00.000Z")) === false, "nor one whose time has come");
    assert(can(ctxFor("confirmed", "cov"), { email: "out@x.com", deactivated_at: "2026-10-12T09:00:00.000Z" }) === false, "nor one whose original advisor left");
    assert(can(new Map()) === false, "nor one whose booking could not be found");
    const plain = buildBulkReassignProgress(demotion, movedItem, ctxFor("confirmed", "cov"));
    assert(plain.moved?.[0].canMoveBack === undefined, "without the planner's inputs, nothing is claimed either way");
    assert(!isBulkReassignProgress({ ...plain, moved: [{ ...plain.moved![0], canMoveBack: "yes" }] }), "a canMoveBack of the wrong type is refused");
  }

  // --- #3615: an audit row for every call a DEMOTION sweep moves ---
  //
  // The move itself is already in the booking's history; what the audit adds is WHY: the Twilio
  // change recorded on the job, from and to which advisor, and that the automation did it.
  const change = {
    from: { debtTeam: ["ultra_high", "high"], backendService: [] },
    to: { debtTeam: ["high"], backendService: [] },
  };
  const demotionJob: BulkReassignJob = {
    ...job,
    created_by: null,
    demotion_marked_at: "2026-10-01T12:00:00.000Z",
    demotion_change: change,
  };
  const auditFakes = () => {
    const audits: AuditEntry[] = [];
    const f = fakeDeps({
      recordAudit: async (entry) => {
        audits.push(entry);
      },
    });
    return { ...f, audits };
  };

  {
    const { deps: d, audits } = auditFakes();
    const out = await processBulkReassignItem(item(), demotionJob, d);
    assert(out.status === "moved", "the demotion move happens");
    assert(audits.length === 1, "one audit row for the one move");
    const a = audits[0];
    assert(a.action === "booking.demotion_reroute", "recorded as a demotion reroute");
    assert(a.actorId === null, "with no human actor: the automation moved it");
    assert(a.targetUserId === "out", "about the demoted advisor, the one who lost the call");
    assert(a.orgId === "org1", "in the job's org");
    const det = a.details as Record<string, unknown>;
    assert(det.booking_id === "bk1" && det.job_id === "job1", "naming the booking and the sweep");
    assert(det.from_user_id === "out" && det.to_user_id === "cov", "from the demoted advisor to the one who took it");
    assert(det.demotion_marked_at === "2026-10-01T12:00:00.000Z", "and when the demotion was recorded");
    assert(JSON.stringify(det.change) === JSON.stringify(change), "and what changed in Twilio");
  }

  {
    // A sweep that is NOT a demotion writes no demotion audit: an admin's or an offboarding's
    // coverage move is not this event.
    const { deps: d, audits } = auditFakes();
    await processBulkReassignItem(item(), job, d);
    assert(audits.length === 0, "a non-demotion sweep writes no demotion audit row");
  }

  {
    // A move that FAILED writes nothing: the trail records what happened, not what was tried.
    const { deps: d, audits } = auditFakes();
    d.reassign = async () => {
      throw new Error("google refused");
    };
    await processBulkReassignItem(item(), demotionJob, d);
    assert(audits.length === 0, "a failed move writes no audit row");
  }

  {
    // A booking already off the advisor was not moved by THIS tick (somebody else moved it, or a
    // tick that crashed before committing already wrote its row), so nothing is claimed here.
    const { deps: d, audits } = auditFakes();
    d.loadBooking = async (id) => ({ id, status: "confirmed", assigned_user_id: "someone_else" });
    await processBulkReassignItem(item(), demotionJob, d);
    assert(audits.length === 0, "a booking found already moved is not claimed as this sweep's move");
  }

  {
    // The move is the item's outcome, not the trail row: a trail write that throws (the real one
    // never does, but the seam does not promise it) must not report a completed move as failed.
    const { deps: d } = auditFakes();
    d.recordAudit = async () => {
      throw new Error("audit_log unreachable");
    };
    const out = await processBulkReassignItem(item(), demotionJob, d);
    assert(out.status === "moved" && out.targetUserId === "cov", "a failing audit write still reports the completed move");
  }

  {
    // A demotion stamped before the earlier tiers were saved still audits the move, with the
    // change recorded as unknown rather than invented.
    const { deps: d, audits } = auditFakes();
    await processBulkReassignItem(item(), { ...demotionJob, demotion_change: null }, d);
    assert(audits.length === 1 && (audits[0].details as Record<string, unknown>).change === null, "an unrecorded change is null");
  }
}

await run();

// --- #3615: draining ONE sweep, for the reroute drill -----------------------------------------
//
// The drill must not move its call alongside the every minute lane, which holds the lane lease
// while it works (two ticks against one daily cap count is what the lease exists to stop). So it
// takes the same lease; while the lane holds it, it waits, and the lane may simply move the call
// itself, which is just as good. The sleep is injected, so nothing here waits for real (L524).
{
  const slept: number[] = [];
  let pending = 1;
  const drained: string[] = [];
  const out = await drainOneJob(
    {
      acquire: async () => ({ release: async () => {}, stillHeld: async () => true }),
      drain: async () => {
        drained.push("job1");
        pending = 0;
      },
      pendingCount: async () => pending,
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
    { attempts: 3, waitMs: 5000 },
  );
  assert(out === "drained" && drained.length === 1 && slept.length === 0, "with the lease free, it drains the sweep at once");
}
{
  // The lane holds the lease and moves the call itself on its next tick.
  const slept: number[] = [];
  let polls = 0;
  const out = await drainOneJob(
    {
      acquire: async () => null,
      drain: async () => {
        throw new Error("must not drain without the lease");
      },
      pendingCount: async () => (++polls >= 2 ? 0 : 1),
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
    { attempts: 3, waitMs: 5000 },
  );
  assert(out === "drained", "a sweep the lane drained counts, without this drain touching it");
  assert(JSON.stringify(slept) === JSON.stringify([5000]), "waiting the injected interval between looks");
}
{
  let threw = "";
  try {
    await drainOneJob(
      {
        acquire: async () => null,
        drain: async () => {},
        pendingCount: async () => 1,
        sleep: async () => {},
      },
      { attempts: 3, waitMs: 5000 },
    );
  } catch (err) {
    threw = String(err);
  }
  assert(threw.includes("still pending"), "a sweep nobody drained is a failure that says so, never a pass");
}
{
  // The lease is released even when the drain throws.
  let released = false;
  let threw = false;
  try {
    await drainOneJob(
      {
        acquire: async () => ({
          release: async () => {
            released = true;
          },
          stillHeld: async () => true,
        }),
        drain: async () => {
          throw new Error("google went away");
        },
        pendingCount: async () => 1,
        sleep: async () => {},
      },
      { attempts: 2, waitMs: 1 },
    );
  } catch {
    threw = true;
  }
  assert(threw && released, "a drain that throws releases the lease and surfaces the error");
}

finish();

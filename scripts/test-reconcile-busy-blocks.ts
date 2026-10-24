// Reconcile sweep tests (#428): a cancelled/missing booking can leave its cached
// busy_block stuck, so the slot keeps showing busy. reconcileCancelledBusyBlocks
// frees only the genuinely-stuck slate rows and NEVER touches a gcal mirror
// (which would risk double-booking over a real external-calendar event).
// Driven through in-memory fakes of BookingDeps (no DB).
// Run: node --experimental-strip-types scripts/test-reconcile-busy-blocks.ts
import {
  reconcileCancelledBusyBlocks,
  type BookingDeps,
} from "../src/lib/booking/orchestration.ts";
import type { BookingStatus, BusyBlock, BusySource } from "../src/lib/db/types.ts";
import { assert, finish } from "./lib/harness.ts";

type Row = Pick<
  BusyBlock,
  "id" | "user_id" | "booking_id" | "source" | "ooo_request_id"
>;

function block(
  id: string,
  user_id: string,
  booking_id: string | null,
  source: BusySource = "slate",
  ooo_request_id: string | null = null,
): Row {
  return { id, user_id, booking_id, source, ooo_request_id };
}

function makeDeps(opts: {
  rows: Row[];
  statuses: Record<string, BookingStatus>;
  /** Bookings whose cancel is still being delivered by the outbox (#784). */
  inflightCancels?: string[];
  /** ooo_requests ids that are still approved (#1464). */
  approvedOoo?: string[];
  /** Bookings cancelled inside the grace window (#4165): their cancel may not have
   *  queued its own block delete yet. */
  justCancelled?: string[];
  /** Block ids still in the table when the delete runs (#4165). Defaults to every
   *  scanned row; a row missing here was deleted by somebody else after the scan. */
  presentAtDelete?: string[];
}) {
  const calls = {
    loadReconcilableBusyBlocks: [] as number[],
    loadBookingStatuses: [] as string[][],
    loadInflightCancelBookingIds: [] as string[][],
    loadApprovedOooRequestIds: [] as string[][],
    loadJustCancelledBookingIds: [] as string[][],
    deleteBusyBlocksByIds: [] as string[][],
  };
  const present = new Set(opts.presentAtDelete ?? opts.rows.map((r) => r.id));
  const deps = {
    loadReconcilableBusyBlocks: async (limit: number) => {
      calls.loadReconcilableBusyBlocks.push(limit);
      return opts.rows;
    },
    loadBookingStatuses: async (ids: string[]) => {
      calls.loadBookingStatuses.push(ids);
      const m = new Map<string, BookingStatus>();
      for (const id of ids) {
        if (opts.statuses[id]) m.set(id, opts.statuses[id]);
      }
      return m;
    },
    loadInflightCancelBookingIds: async (ids: string[]) => {
      calls.loadInflightCancelBookingIds.push(ids);
      const inflight = new Set(opts.inflightCancels ?? []);
      return new Set(ids.filter((id) => inflight.has(id)));
    },
    loadApprovedOooRequestIds: async (ids: string[]) => {
      calls.loadApprovedOooRequestIds.push(ids);
      const approved = new Set(opts.approvedOoo ?? []);
      return new Set(ids.filter((id) => approved.has(id)));
    },
    loadJustCancelledBookingIds: async (ids: string[]) => {
      calls.loadJustCancelledBookingIds.push(ids);
      const recent = new Set(opts.justCancelled ?? []);
      return new Set(ids.filter((id) => recent.has(id)));
    },
    // Like the real `.delete().in("id", ids).select("id")`: answers with the rows it
    // actually removed, which excludes any already gone.
    deleteBusyBlocksByIds: async (ids: string[]) => {
      calls.deleteBusyBlocksByIds.push(ids);
      const removed = ids.filter((id) => present.has(id));
      for (const id of removed) present.delete(id);
      return removed;
    },
  } as unknown as BookingDeps;
  return { deps, calls };
}

async function run() {
  {
    // The core mixed case: free cancelled + orphan + missing; keep everything
    // active; never touch a gcal mirror even when its booking is cancelled.
    const rows: Row[] = [
      block("b-cancelled", "u1", "bk-cancelled"), // slate, cancelled -> FREE
      block("b-orphan", "u1", null), // slate, no booking -> FREE
      block("b-missing", "u2", "bk-gone"), // slate, booking missing -> FREE
      block("b-confirmed", "u3", "bk-confirmed"), // slate, active -> KEEP
      block("b-rescheduled", "u3", "bk-resched"), // slate, moved-in-place active -> KEEP
      block("b-completed", "u4", "bk-done"), // slate, happened -> KEEP
      block("b-gcal", "u5", "bk-cancelled", "gcal"), // gcal mirror -> KEEP (double-book guard)
    ];
    const { deps, calls } = makeDeps({
      rows,
      statuses: {
        "bk-cancelled": "cancelled",
        "bk-confirmed": "confirmed",
        "bk-resched": "rescheduled",
        "bk-done": "completed",
        // "bk-gone" intentionally absent -> missing booking
      },
    });
    const res = await reconcileCancelledBusyBlocks(deps, 500);

    const deleted = calls.deleteBusyBlocksByIds[0] ?? [];
    const deletedSet = new Set(deleted);
    assert(res.freed === 3, "frees exactly the 3 stuck rows");
    assert(deletedSet.has("b-cancelled"), "frees a slate block over a cancelled booking");
    assert(deletedSet.has("b-orphan"), "frees a slate block with no booking_id");
    assert(deletedSet.has("b-missing"), "frees a slate block whose booking is gone");
    assert(!deletedSet.has("b-confirmed"), "keeps a confirmed booking's slot busy");
    assert(!deletedSet.has("b-rescheduled"), "keeps a rescheduled (moved-in-place) booking's slot busy");
    assert(!deletedSet.has("b-completed"), "keeps a completed booking's slot");
    assert(!deletedSet.has("b-gcal"), "NEVER frees a gcal mirror, even over a cancelled booking");
    assert(
      JSON.stringify(res.userIds.slice().sort()) === JSON.stringify(["u1", "u2"]),
      "reports the distinct affected agents for bounded recompute",
    );
    // gcal rows must not even be looked up against bookings is unnecessary, but
    // we must not query the missing/active ones wastefully beyond the candidates.
    assert(calls.loadReconcilableBusyBlocks[0] === 500, "passes the limit through");
  }
  {
    // Nothing stuck -> no delete call at all (cheap common case every tick).
    const rows: Row[] = [
      block("b1", "u1", "bk1"),
      block("b2", "u2", "bk2", "gcal"),
    ];
    const { deps, calls } = makeDeps({
      rows,
      statuses: { bk1: "confirmed" },
    });
    const res = await reconcileCancelledBusyBlocks(deps, 500);
    assert(res.freed === 0, "no stuck rows -> frees nothing");
    assert(res.userIds.length === 0, "no stuck rows -> no agents to recompute");
    assert(calls.deleteBusyBlocksByIds.length === 0, "no stuck rows -> skips the delete round-trip");
  }

  // #784: the cancel path flips status to `cancelled` FIRST and only then deletes
  // the block, as an outbox step behind a slow Google delete. So a cancel that is
  // merely mid-flight looks exactly like a missed write-through delete: the sweep
  // used to free the block (harmless, it was going to be deleted anyway) and then
  // report it as damage, firing "a write-through delete was missed, check
  // cancel-path health" at a perfectly healthy cancel path.
  {
    const rows: Row[] = [
      block("b-inflight", "u1", "bk-inflight"), // cancel still delivering -> LEAVE IT
      block("b-delivered", "u2", "bk-delivered"), // cancel finished, block survived -> FREE
    ];
    const { deps, calls } = makeDeps({
      rows,
      statuses: { "bk-inflight": "cancelled", "bk-delivered": "cancelled" },
      inflightCancels: ["bk-inflight"],
    });
    const res = await reconcileCancelledBusyBlocks(deps, 500);

    const deleted = new Set(calls.deleteBusyBlocksByIds[0] ?? []);
    assert(!deleted.has("b-inflight"), "#784: leaves the block of a cancel that is still delivering");
    assert(deleted.has("b-delivered"), "#784: still frees a block whose cancel finished without deleting it");
    // The counter is what the Slack alert reports, so an in-flight cancel must not
    // inflate it, or the alert overstates the real miss rate.
    assert(res.freed === 1, "#784: an in-flight cancel is not counted as a missed delete");
    assert(
      JSON.stringify(res.userIds) === JSON.stringify(["u2"]),
      "#784: does not recompute the in-flight cancel's agent",
    );
  }

  {
    // Every stuck row is just an in-flight cancel: nothing was missed, so the sweep
    // must issue no delete and report nothing (the quiet, common case).
    const rows: Row[] = [block("b1", "u1", "bk1")];
    const { deps, calls } = makeDeps({
      rows,
      statuses: { bk1: "cancelled" },
      inflightCancels: ["bk1"],
    });
    const res = await reconcileCancelledBusyBlocks(deps, 500);
    assert(res.freed === 0, "#784: an all-in-flight tick frees nothing");
    assert(calls.deleteBusyBlocksByIds.length === 0, "#784: an all-in-flight tick issues no delete");
  }

  {
    // An orphan block has no booking, so it has no cancel to be in flight. The
    // in-flight check must not accidentally start protecting orphans, which are the
    // rows this sweep exists to free.
    const rows: Row[] = [block("b-orphan", "u1", null)];
    const { deps } = makeDeps({ rows, statuses: {}, inflightCancels: [] });
    const res = await reconcileCancelledBusyBlocks(deps, 500);
    assert(res.freed === 1, "#784: still frees an orphan block with no booking at all");
  }

  // #1464: the OOO fallback is a SECOND writer of the shape this sweep read as an
  // orphan (source=slate, booking_id null), and it is the only thing blocking
  // approved time off when the agent's calendar event could not be created. Both
  // directions in one scan, or the test proves nothing (L1): the owned block must
  // survive the same pass that frees a genuine orphan.
  {
    const rows: Row[] = [
      block("b-ooo", "u1", null, "slate", "ooo-approved"), // owned by live time off -> KEEP
      block("b-orphan", "u2", null), // nothing owns it -> FREE
    ];
    const { deps, calls } = makeDeps({
      rows,
      statuses: {},
      approvedOoo: ["ooo-approved"],
    });
    const res = await reconcileCancelledBusyBlocks(deps, 500);

    const deleted = new Set(calls.deleteBusyBlocksByIds[0] ?? []);
    assert(!deleted.has("b-ooo"), "#1464: keeps a block owned by an approved time off");
    assert(deleted.has("b-orphan"), "#1464: still frees a block nothing owns");
    assert(res.freed === 1, "#1464: an owned block is not counted as a missed delete");
    assert(
      JSON.stringify(res.userIds) === JSON.stringify(["u2"]),
      "#1464: does not recompute the protected agent's buckets",
    );
  }

  {
    // The mirror direction: once the time off is no longer approved (cancelled,
    // rejected, or the row is gone), nothing owns the block, so the sweep must
    // still free it. Without this an OOO-owned block whose cancel path missed its
    // delete could never be freed by anything.
    const rows: Row[] = [
      block("b-live", "u1", null, "slate", "ooo-approved"),
      block("b-cancelled-ooo", "u2", null, "slate", "ooo-cancelled"),
      block("b-gone-ooo", "u3", null, "slate", "ooo-deleted"),
    ];
    const { deps, calls } = makeDeps({
      rows,
      statuses: {},
      approvedOoo: ["ooo-approved"],
    });
    const res = await reconcileCancelledBusyBlocks(deps, 500);

    const deleted = new Set(calls.deleteBusyBlocksByIds[0] ?? []);
    assert(deleted.has("b-cancelled-ooo"), "#1464: frees a block whose time off is no longer approved");
    assert(deleted.has("b-gone-ooo"), "#1464: frees a block whose time off row is gone");
    assert(!deleted.has("b-live"), "#1464: keeps the still-approved one in the same scan");
    assert(res.freed === 2, "#1464: counts only the two it freed");
    assert(
      JSON.stringify(calls.loadApprovedOooRequestIds[0]?.slice().sort()) ===
        JSON.stringify(["ooo-approved", "ooo-cancelled", "ooo-deleted"]),
      "#1464: asks about every owner in the scan, in one batched read",
    );
  }

  {
    // No row carries an owner: skip the round-trip entirely (this is every tick).
    const rows: Row[] = [block("b1", "u1", "bk1")];
    const { deps, calls } = makeDeps({ rows, statuses: { bk1: "confirmed" } });
    await reconcileCancelledBusyBlocks(deps, 500);
    assert(
      calls.loadApprovedOooRequestIds.length === 0,
      "#1464: no owned rows -> skips the ooo lookup",
    );
  }

  {
    // The alert says what to go and check, so the two kinds must not be merged:
    // a missed write-through delete points at cancel-path health, an unowned
    // orphan does not (it never referenced a booking at all).
    const rows: Row[] = [
      block("b-cancelled", "u1", "bk-cancelled"),
      block("b-orphan", "u2", null),
    ];
    const { deps } = makeDeps({
      rows,
      statuses: { "bk-cancelled": "cancelled" },
    });
    const res = await reconcileCancelledBusyBlocks(deps, 500);
    assert(res.freedCancelled === 1, "#1464: counts the cancelled-booking miss separately");
    assert(res.freedOrphans === 1, "#1464: counts the unowned orphan separately");
    assert(res.freed === 2, "#1464: the two counts add up to the total freed");
  }

  // #4165, window 1: the cancel finished between this sweep's block read and its
  // status read. The block was already gone when the delete ran, so nothing was
  // freed, and nothing may be reported: a count of candidates paged "a write-through
  // delete was missed" about a cancel that had deleted its own block.
  {
    const rows: Row[] = [
      block("b-raced", "u1", "bk-raced"), // deleted by the cancel after the scan
      block("b-stuck", "u2", "bk-stuck"), // genuinely survived its cancel
    ];
    const { deps, calls } = makeDeps({
      rows,
      statuses: { "bk-raced": "cancelled", "bk-stuck": "cancelled" },
      presentAtDelete: ["b-stuck"],
    });
    const res = await reconcileCancelledBusyBlocks(deps, 500);
    assert(
      (calls.deleteBusyBlocksByIds[0] ?? []).slice().sort().join(",") === "b-raced,b-stuck",
      "#4165: still asks to delete both candidates (deleting a gone row is harmless)",
    );
    assert(res.freed === 1, "#4165: counts only the row the delete actually removed");
    assert(res.freedCancelled === 1, "#4165: the cancelled count comes from removed rows too");
    assert(
      JSON.stringify(res.freedBookingIds) === JSON.stringify(["bk-stuck"]),
      "#4165: names only the booking whose block was really freed",
    );
    assert(
      JSON.stringify(res.userIds) === JSON.stringify(["u2"]),
      "#4165: recomputes only the agent whose block was really freed",
    );
  }

  {
    // Every candidate was already gone: the tick freed nothing and must say so.
    const rows: Row[] = [block("b-raced", "u1", "bk-raced")];
    const { deps } = makeDeps({
      rows,
      statuses: { "bk-raced": "cancelled" },
      presentAtDelete: [],
    });
    const res = await reconcileCancelledBusyBlocks(deps, 500);
    assert(res.freed === 0, "#4165: a delete that removed nothing reports nothing freed");
    assert(res.freedCancelled === 0 && res.freedOrphans === 0, "#4165: and neither kind is counted");
    assert(res.userIds.length === 0 && res.freedBookingIds.length === 0, "#4165: and no agent or booking is named");
    assert(res.scanned === 1, "#4165: the scan size is still reported for the cursor");
  }

  // #4165, window 2: the status flip and the cancel's outbox insert are separate
  // statements, so for a moment a cancelled booking has no pending outbox row and
  // looks exactly like a cancel that finished and missed its delete. A booking
  // cancelled inside the grace is left alone; one cancelled earlier is a real miss.
  {
    const rows: Row[] = [
      block("b-just", "u1", "bk-just"), // cancelled 10 s ago, outbox row not written yet
      block("b-old", "u2", "bk-old"), // cancelled 2 min ago, block still here
      block("b-orphan", "u3", null), // the orphan path must be untouched by the grace
    ];
    const { deps, calls } = makeDeps({
      rows,
      statuses: { "bk-just": "cancelled", "bk-old": "cancelled" },
      justCancelled: ["bk-just"],
    });
    const res = await reconcileCancelledBusyBlocks(deps, 500);
    const deleted = new Set(calls.deleteBusyBlocksByIds[0] ?? []);
    assert(!deleted.has("b-just"), "#4165: leaves a booking cancelled inside the grace alone");
    assert(deleted.has("b-old"), "#4165: frees a booking cancelled before the grace whose block survived");
    assert(deleted.has("b-orphan"), "#4165: still frees an orphan, which has no cancel to wait for");
    assert(res.freedCancelled === 1 && res.freedOrphans === 1, "#4165: the just-cancelled booking is not counted");
    assert(
      JSON.stringify(res.freedBookingIds) === JSON.stringify(["bk-old"]),
      "#4165: names only the booking past the grace",
    );
    assert(
      JSON.stringify(calls.loadJustCancelledBookingIds[0]?.slice().sort()) === JSON.stringify(["bk-just", "bk-old"]),
      "#4165: asks about every booking in the scan, in one batched read",
    );
  }

  {
    // No booking in the scan: skip the grace read entirely (an orphan-only tick).
    const rows: Row[] = [block("b-orphan", "u1", null)];
    const { deps, calls } = makeDeps({ rows, statuses: {} });
    await reconcileCancelledBusyBlocks(deps, 500);
    assert(calls.loadJustCancelledBookingIds.length === 0, "#4165: no bookings -> skips the grace read");
  }
}

await run();

finish();

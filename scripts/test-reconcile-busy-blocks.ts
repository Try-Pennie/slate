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
}) {
  const calls = {
    loadReconcilableBusyBlocks: [] as number[],
    loadBookingStatuses: [] as string[][],
    loadInflightCancelBookingIds: [] as string[][],
    loadApprovedOooRequestIds: [] as string[][],
    deleteBusyBlocksByIds: [] as string[][],
  };
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
    deleteBusyBlocksByIds: async (ids: string[]) => {
      calls.deleteBusyBlocksByIds.push(ids);
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
}

await run();

finish();

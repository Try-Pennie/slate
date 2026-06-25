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

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

type Row = Pick<BusyBlock, "id" | "user_id" | "booking_id" | "source">;

function block(
  id: string,
  user_id: string,
  booking_id: string | null,
  source: BusySource = "slate",
): Row {
  return { id, user_id, booking_id, source };
}

function makeDeps(opts: {
  rows: Row[];
  statuses: Record<string, BookingStatus>;
}) {
  const calls = {
    loadReconcilableBusyBlocks: [] as number[],
    loadBookingStatuses: [] as string[][],
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
}

await run();

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

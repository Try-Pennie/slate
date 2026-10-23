import { describe, it, expect, vi, beforeEach } from "vitest";

// #784: the reconcile-cancelled sweep must not treat a cancel that is still being
// delivered as a missed delete. The pure sweep logic is covered by
// scripts/test-reconcile-busy-blocks.ts; what THIS file pins is the real DB wiring,
// and specifically the FAILURE path of the new in-flight lookup.
//
// That read has to fail SAFE toward not sweeping. If a transient blip made it return
// an empty set, every in-flight cancel would look stuck again and the sweep would go
// right back to freeing them and firing "a write-through delete was missed, check
// cancel-path health" at a healthy cancel path: the exact bug this guard exists to
// stop, resurrected by a read error. So it throws and the tick aborts instead.

const state = vi.hoisted(() => ({
  busyBlocks: [] as unknown[],
  bookings: [] as unknown[],
  outbox: [] as unknown[],
  outboxError: null as null | { message: string },
}));

const deleteBusyBlocksByIds = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      // #4165: the just-cancelled read is the bookings query filtered on updated_at.
      // Every booking here was cancelled long ago, so it answers with none.
      let graceRead = false;
      const rowsFor = () => {
        if (table === "busy_blocks") return { data: state.busyBlocks, error: null };
        if (table === "bookings") return { data: graceRead ? [] : state.bookings, error: null };
        if (table === "booking_outbox") {
          return state.outboxError
            ? { data: null, error: state.outboxError }
            : { data: state.outbox, error: null };
        }
        return { data: [], error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        gte: () => b,
        in: () => b,
        gt: () => {
          graceRead = true;
          return b;
        },
        order: () => b,
        range: () => b,
        delete: () => ({
          // #4165: the delete answers with the rows it removed; all of them are present.
          in: (_col: string, ids: string[]) => ({
            select: () => {
              deleteBusyBlocksByIds(ids);
              return Promise.resolve({ data: ids.map((id) => ({ id })), error: null });
            },
          }),
        }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(rowsFor()).then(resolve),
      };
      return b;
    },
  }),
}));

// #2357: the sweep's slot refresh is the shared pooled, counted one, not a loop of
// per code pool computes. Mocked so these cases can see it was asked for.
const slotCache = vi.hoisted(() => ({
  recomputeBucketSlotsForToday: vi.fn(async () => {}),
  getBucketSlotsWithFallback: vi.fn(),
  refreshPoolsForAgents: vi.fn(async () => ({ refreshed: 1, deferred: 0, failed: 0, debounced: 0 })),
}));
vi.mock("@/lib/availability/slot-cache", () => slotCache);

import { reconcileCancelledBusyBlocks } from "./service";

const CANCELLED_BLOCK = { id: "blk1", user_id: "u1", booking_id: "bk1", source: "slate" };

beforeEach(() => {
  vi.clearAllMocks();
  state.busyBlocks = [CANCELLED_BLOCK];
  state.bookings = [{ id: "bk1", status: "cancelled" }];
  state.outbox = [];
  state.outboxError = null;
});

describe("reconcileCancelledBusyBlocks in-flight guard (#784)", () => {
  it("leaves the block alone while the cancel's own delete step is still pending", async () => {
    state.outbox = [{ booking_id: "bk1" }]; // cancel still delivering

    const res = await reconcileCancelledBusyBlocks(200);

    expect(res.freed).toBe(0);
    expect(deleteBusyBlocksByIds).not.toHaveBeenCalled();
  });

  it("frees the block once the cancel is delivered and the block still exists", async () => {
    state.outbox = []; // nothing pending: this is a genuine missed delete

    const res = await reconcileCancelledBusyBlocks(200);

    expect(res.freed).toBe(1);
    // #3585: the freed booking is named, so a genuine missed delete is distinguishable
    // in the log from the cancel/reconcile race rather than inferred from a snapshot.
    expect(res.freedBookingIds).toEqual(["bk1"]);
    expect(deleteBusyBlocksByIds).toHaveBeenCalledWith(["blk1"]);
    // #2357: one bounded, pooled refresh for the freed agents, never a per code loop.
    expect(slotCache.refreshPoolsForAgents).toHaveBeenCalledTimes(1);
    expect(slotCache.refreshPoolsForAgents).toHaveBeenCalledWith(["u1"], "reconcile");
    expect(slotCache.recomputeBucketSlotsForToday).not.toHaveBeenCalled();
  });

  it("refreshes nothing when nothing was freed", async () => {
    state.outbox = [{ booking_id: "bk1" }];

    await reconcileCancelledBusyBlocks(200);

    expect(slotCache.refreshPoolsForAgents).not.toHaveBeenCalled();
  });

  it("aborts the tick when the in-flight read fails, rather than freeing on a blind guess", async () => {
    state.outboxError = { message: "read timeout" };

    await expect(reconcileCancelledBusyBlocks(200)).rejects.toThrow(/read timeout/);
    // The damage a silent empty-set fallback would do: freeing a healthy in-flight
    // cancel's block and reporting it as a missed delete.
    expect(deleteBusyBlocksByIds).not.toHaveBeenCalled();
  });
});

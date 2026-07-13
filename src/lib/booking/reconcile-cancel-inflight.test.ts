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
      const rowsFor = () => {
        if (table === "busy_blocks") return { data: state.busyBlocks, error: null };
        if (table === "bookings") return { data: state.bookings, error: null };
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
        order: () => b,
        range: () => b,
        delete: () => ({
          in: (_col: string, ids: string[]) => {
            deleteBusyBlocksByIds(ids);
            return Promise.resolve({ error: null });
          },
        }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(rowsFor()).then(resolve),
      };
      return b;
    },
  }),
}));

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
    expect(deleteBusyBlocksByIds).toHaveBeenCalledWith(["blk1"]);
  });

  it("aborts the tick when the in-flight read fails, rather than freeing on a blind guess", async () => {
    state.outboxError = { message: "read timeout" };

    await expect(reconcileCancelledBusyBlocks(200)).rejects.toThrow(/read timeout/);
    // The damage a silent empty-set fallback would do: freeing a healthy in-flight
    // cancel's block and reporting it as a missed delete.
    expect(deleteBusyBlocksByIds).not.toHaveBeenCalled();
  });
});

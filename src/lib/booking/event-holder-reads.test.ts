import { describe, it, expect, vi, beforeEach } from "vitest";

// #3215 (L744): before the deletion drain removes a Google event it asks whether a
// live booking now holds that event id. The orchestration's own suite
// (scripts/test-booking-insert-deadline.ts) proves the drain obeys the answer;
// this pins that the LIVE query gives a true one.
//
// The mock below is a small evaluator rather than a stub that hands back fixed
// rows: it applies `eq`, `in` and `limit` to the rows it holds, in the order the
// query states them, and records the `order` columns. So a query that read a
// capped, unfiltered page of every booking naming the event (the first version
// of this read) really does lose a live holder sitting behind cancelled ones,
// rather than passing because the fixture happened to put the holder first.

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
  orders: [] as { table: string; column: string }[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      let rows = [...(state.rows[table] ?? [])];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, v: unknown) => ((rows = rows.filter((r) => r[col] === v)), b),
        in: (col: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[col]))), b),
        lt: (col: string, v: number) => ((rows = rows.filter((r) => (r[col] as number) < v)), b),
        is: (col: string, v: unknown) => ((rows = rows.filter((r) => r[col] === v)), b),
        gte: () => b,
        order: (column: string) => (state.orders.push({ table, column }), b),
        limit: (n: number) => ((rows = rows.slice(0, n)), b),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return b;
    },
  }),
}));

import { realDeps } from "./service";

const ACTIVE = ["confirmed", "rescheduled", "completed"] as const;

beforeEach(() => {
  state.rows = {};
  state.orders = [];
});

describe("the live holder question (#3215)", () => {
  it("finds a live holder behind any number of cancelled bookings naming the event", async () => {
    state.rows.bookings = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `gone-${i}`, gcal_event_id: "evt", status: "cancelled" })),
      { id: "live", gcal_event_id: "evt", status: "confirmed" },
    ];
    await expect(realDeps().liveBookingHoldingEvent("evt", ACTIVE)).resolves.toBe("live");
  });

  it("answers null when only cancelled bookings name the event", async () => {
    state.rows.bookings = [{ id: "gone", gcal_event_id: "evt", status: "cancelled" }];
    await expect(realDeps().liveBookingHoldingEvent("evt", ACTIVE)).resolves.toBeNull();
  });

  it("never answers with a booking holding a different event", async () => {
    state.rows.bookings = [{ id: "other", gcal_event_id: "evt-2", status: "confirmed" }];
    await expect(realDeps().liveBookingHoldingEvent("evt", ACTIVE)).resolves.toBeNull();
  });
});

// #3217: a reschedule or reassign that failed after writing its event queues the
// deletion, and a resume of that write derives the same id. So the drain holds the
// row while ANY write still in flight pins the event, not only a create.
describe("a write still in flight pins its event (#3215, #3217)", () => {
  it("a pending create reservation pins it", async () => {
    state.rows.booking_reservations = [{ id: "r", gcal_client_id: "evt", status: "pending" }];
    await expect(realDeps().pendingWritePinsEvent("evt")).resolves.toBe(true);
  });

  it("a standing reschedule lock pins it", async () => {
    state.rows.reschedule_locks = [{ booking_id: "bk", gcal_client_id: "evt" }];
    await expect(realDeps().pendingWritePinsEvent("evt")).resolves.toBe(true);
  });

  it("a reassign intent pins it", async () => {
    state.rows.reassign_intents = [{ booking_id: "bk", gcal_client_id: "evt" }];
    await expect(realDeps().pendingWritePinsEvent("evt")).resolves.toBe(true);
  });

  it("nothing pins it when every write names another event or is no longer pending", async () => {
    state.rows.booking_reservations = [
      { id: "r1", gcal_client_id: "evt", status: "completed" },
      { id: "r2", gcal_client_id: "evt-2", status: "pending" },
    ];
    state.rows.reschedule_locks = [{ booking_id: "bk", gcal_client_id: "evt-2" }];
    state.rows.reassign_intents = [{ booking_id: "bk", gcal_client_id: "evt-3" }];
    await expect(realDeps().pendingWritePinsEvent("evt")).resolves.toBe(false);
  });
});

describe("the deletion queue rotates (#3215)", () => {
  it("loads the least recently touched rows first, so held rows cannot fill every page", async () => {
    state.rows.pending_event_deletions = [];
    await realDeps().loadPendingEventDeletions(20);
    expect(state.orders.filter((o) => o.table === "pending_event_deletions").map((o) => o.column)).toEqual([
      "updated_at",
    ]);
  });

  it("the creation orphan worklist rotates the same way", async () => {
    state.rows.pending_event_deletions = [];
    await realDeps().loadCreationOrphans(10);
    expect(state.orders.filter((o) => o.table === "pending_event_deletions").map((o) => o.column)).toEqual([
      "updated_at",
    ]);
  });
});

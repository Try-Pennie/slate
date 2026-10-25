import { describe, it, expect, vi } from "vitest";
import { reconcileMissingBusyBlocks, type BookingDeps, type ActiveUpcomingBooking } from "./orchestration";

// #3585: the reconcile-missing sweep reads active upcoming bookings, then separately
// reads their busy_blocks. A cancellation landing BETWEEN those two reads deletes the
// block and looks exactly like a missed write-through INSERT: the booking read saw it
// active, the block read saw the block gone, so the sweep re-created a block for a
// booking being cancelled and paged "a write-through INSERT had been missed", and the
// next tick freed that block and paged again. One ordinary customer cancel near a sweep
// manufactured two false "write health" pages (2026-10-10), eroding a real double-booking
// alarm (L36).
//
// #3585 re-verified the candidates just before inserting, which left the gap between
// that read and the insert. #3592 closes it: the active check and the insert are ONE
// statement (`recreate_missing_busy_blocks`, migration 0204), and every count comes
// from the rows it says it inserted. The statement itself is proved in a real Postgres
// by `pnpm verify:recreate-missing-busy-blocks-sql`; these drive the orchestration with
// hand written deps so each answer is controlled exactly.

const bookingA: ActiveUpcomingBooking = {
  id: "A",
  user_id: "uA",
  starts_at: "2026-10-12T15:00:00.000Z",
  ends_at: "2026-10-12T15:30:00.000Z",
};

function makeDeps(over: Partial<BookingDeps>): BookingDeps {
  return {
    // Read 1: the booking looked active.
    loadActiveUpcomingBookings: vi.fn(async () => [bookingA]),
    // Read 2: no block (either genuinely missed, or a cancel just deleted it).
    loadBusyBlockBookingIds: vi.fn(async () => new Set<string>()),
    // The conditional insert: by default the booking is still active and gets its block.
    recreateMissingBusyBlocks: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ booking_id: id, user_id: `u${id}` })),
    ),
    ...over,
  } as unknown as BookingDeps;
}

describe("reconcileMissingBusyBlocks re-creates in one conditional statement (#3585, #3592)", () => {
  it("re-creates a genuinely missing block when the booking is still active", async () => {
    const deps = makeDeps({});
    const res = await reconcileMissingBusyBlocks(deps, 200);
    expect(res.recreated).toBe(1);
    expect(res.bookingIds).toEqual(["A"]);
    expect(res.userIds).toEqual(["uA"]);
    expect(deps.recreateMissingBusyBlocks).toHaveBeenCalledTimes(1);
  });

  it("does NOT count (or page) a booking the statement refused because it was cancelled", async () => {
    // The race: active in read 1, its block gone in read 2 (the cancel deleted it), and
    // the statement's own check finds it cancelled, so it inserts and returns nothing.
    // Nothing is counted, so no false "missed write" page and no agent recomputed.
    const deps = makeDeps({ recreateMissingBusyBlocks: vi.fn(async () => []) });
    const res = await reconcileMissingBusyBlocks(deps, 200);
    expect(res.recreated).toBe(0);
    expect(res.bookingIds).toEqual([]);
    expect(res.userIds).toEqual([]);
    // scanned still reflects what the first read saw, so the sweep is not reported as
    // having looked at nothing.
    expect(res.scanned).toBe(1);
  });

  it("counts only the rows the statement inserted, never the candidates", async () => {
    // Two candidates; the statement inserts one (the other was cancelled or its block
    // landed meanwhile). The agent named is the one the inserted row carries.
    const other: ActiveUpcomingBooking = { ...bookingA, id: "C", user_id: "uC" };
    const deps = makeDeps({
      loadActiveUpcomingBookings: vi.fn(async () => [bookingA, other]),
      recreateMissingBusyBlocks: vi.fn(async () => [{ booking_id: "C", user_id: "uC" }]),
    });
    const res = await reconcileMissingBusyBlocks(deps, 200);
    expect(res).toEqual({ recreated: 1, bookingIds: ["C"], userIds: ["uC"], scanned: 2 });
  });

  it("asks about only the MISSING set, not every scanned booking", async () => {
    // One booking has a block (not missing), one does not. Only the block-less one is
    // sent, so the statement works on candidates, never the whole page.
    const withBlock: ActiveUpcomingBooking = { ...bookingA, id: "B", user_id: "uB" };
    const deps = makeDeps({
      loadActiveUpcomingBookings: vi.fn(async () => [bookingA, withBlock]),
      loadBusyBlockBookingIds: vi.fn(async () => new Set(["B"])), // B already has a block
    });
    const res = await reconcileMissingBusyBlocks(deps, 200);
    expect(res.bookingIds).toEqual(["A"]);
    expect(deps.recreateMissingBusyBlocks).toHaveBeenCalledWith(["A"]);
  });

  it("issues no insert when nothing is missing", async () => {
    const deps = makeDeps({
      loadBusyBlockBookingIds: vi.fn(async () => new Set(["A"])), // A already has a block
    });
    const res = await reconcileMissingBusyBlocks(deps, 200);
    expect(res.recreated).toBe(0);
    expect(deps.recreateMissingBusyBlocks).not.toHaveBeenCalled();
  });

  it("a refused insert aborts the sweep instead of reporting the candidates as re-created", async () => {
    const deps = makeDeps({
      recreateMissingBusyBlocks: vi.fn(async () => {
        throw new Error("recreate_missing_busy_blocks refused");
      }),
    });
    await expect(reconcileMissingBusyBlocks(deps, 200)).rejects.toThrow(/refused/);
  });
});

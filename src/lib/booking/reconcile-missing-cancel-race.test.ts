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
// The fix re-verifies the NARROW candidate set is still active immediately before
// re-creating, closing the window. These drive the orchestration logic with hand
// written deps so each read's answer is controlled exactly.

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
    // Re-verify (the #3585 read): still active by default.
    loadStillActiveBookingIds: vi.fn(async (ids: string[]) => new Set(ids)),
    insertBusyBlocks: vi.fn(async () => {}),
    ...over,
  } as unknown as BookingDeps;
}

describe("reconcileMissingBusyBlocks re-verifies before re-creating (#3585)", () => {
  it("re-creates a genuinely missing block when the booking is still active", async () => {
    const insertBusyBlocks = vi.fn(async () => {});
    const deps = makeDeps({ insertBusyBlocks });
    const res = await reconcileMissingBusyBlocks(deps, 200);
    expect(res.recreated).toBe(1);
    expect(res.bookingIds).toEqual(["A"]);
    expect(res.userIds).toEqual(["uA"]);
    expect(insertBusyBlocks).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-create (or page) when the booking was cancelled between the two reads", async () => {
    // The race: active in read 1, its block gone in read 2 (the cancel deleted it),
    // and the re-verify finds it no longer active. Nothing is re-created, so no false
    // "missed write" page, and no block for the next tick to free and page about again.
    const insertBusyBlocks = vi.fn(async () => {});
    const loadStillActiveBookingIds = vi.fn(async () => new Set<string>());
    const deps = makeDeps({ insertBusyBlocks, loadStillActiveBookingIds });
    const res = await reconcileMissingBusyBlocks(deps, 200);
    expect(res.recreated).toBe(0);
    expect(res.bookingIds).toEqual([]);
    expect(res.userIds).toEqual([]);
    expect(insertBusyBlocks).not.toHaveBeenCalled();
    // scanned still reflects what the first read saw, so the sweep is not reported as
    // having looked at nothing.
    expect(res.scanned).toBe(1);
  });

  it("re-verifies only the MISSING set, not every scanned booking", async () => {
    // One booking has a block (not missing), one does not. Only the block-less one is
    // re-verified, so the extra read is paid on candidates, never the whole page.
    const withBlock: ActiveUpcomingBooking = { ...bookingA, id: "B", user_id: "uB" };
    const loadStillActiveBookingIds = vi.fn(async (ids: string[]) => new Set(ids));
    const deps = makeDeps({
      loadActiveUpcomingBookings: vi.fn(async () => [bookingA, withBlock]),
      loadBusyBlockBookingIds: vi.fn(async () => new Set(["B"])), // B already has a block
      loadStillActiveBookingIds,
    });
    const res = await reconcileMissingBusyBlocks(deps, 200);
    expect(res.bookingIds).toEqual(["A"]);
    expect(loadStillActiveBookingIds).toHaveBeenCalledWith(["A"]);
  });

  it("skips the re-verify read entirely when nothing is missing", async () => {
    const loadStillActiveBookingIds = vi.fn(async (ids: string[]) => new Set(ids));
    const deps = makeDeps({
      loadBusyBlockBookingIds: vi.fn(async () => new Set(["A"])), // A already has a block
      loadStillActiveBookingIds,
    });
    const res = await reconcileMissingBusyBlocks(deps, 200);
    expect(res.recreated).toBe(0);
    expect(loadStillActiveBookingIds).not.toHaveBeenCalled();
  });
});

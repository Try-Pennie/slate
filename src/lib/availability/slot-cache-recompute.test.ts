import { describe, it, expect, vi, beforeEach } from "vitest";

// #216: recomputeBucketSlotsForToday must compute the precomputed row against the
// runtime org-wide horizon (store > env > default), so raising the horizon makes
// rows actually cover more days and lowering it bounds them. The read path is
// untouched; only the write tracks the horizon. IO is fully mocked.
//
// #1326 split that into TWO numbers that must not be confused, which is why this
// file now asserts both. The horizon counts BOOKABLE days, so:
//
//   the compute WINDOW is searchWindowDays(horizon), deliberately wider, because a
//   closed day inside it would otherwise eat one of the days a lead is offered; and
//   the TRIM TARGET passed down is the horizon itself.
//
// Asserting only the window would pass while the trim was wrong, and the bucket
// would quietly offer several days too many.

const recomputeBucketSlots = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./precompute", () => ({
  recomputeBucketSlots,
  readBucketSlotsRow: vi.fn(),
  writeBucketSlotsRow: vi.fn(),
  storeBucketSlotsRow: vi.fn(async () => "written" as const),
  bucketsForAgent: vi.fn(async () => []),
}));
vi.mock("./service", () => ({ getBucketSlots: vi.fn(), loadBucketSlotInputs: vi.fn() }));
const loadBookingHorizonDays = vi.hoisted(() => vi.fn(async () => 7));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays }));

import { recomputeBucketSlotsForToday } from "./slot-cache";
import { searchWindowDays } from "./bookable-days";

const windowDays = (call: unknown[]): number => {
  const fromIso = call[1] as string;
  const toIso = call[2] as string;
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
};

describe("recomputeBucketSlotsForToday horizon window", () => {
  beforeEach(() => {
    recomputeBucketSlots.mockClear();
    loadBookingHorizonDays.mockClear();
    loadBookingHorizonDays.mockResolvedValue(7);
  });

  /** The bookable-day count handed down as the trim target. */
  const trimTarget = (call: unknown[]): number | undefined => call[4] as number | undefined;

  // #3119: a refused row is not a refresh. The throw reaches the caller (the
  // monitor's heal reports it through onHealError, the booking path logs it),
  // rather than the recompute reading as done.
  it("passes a refused row write up to its caller", async () => {
    const refused = new Error("the bucket_slots row for 411 was refused");
    recomputeBucketSlots.mockRejectedValueOnce(refused);
    await expect(recomputeBucketSlotsForToday("411", true)).rejects.toBe(refused);
  });

  // And the L1 entry is dropped on that path too, as the pooled path does: a stale
  // entry must never outlive the attempt.
  it("drops the L1 cache entry even when the recompute throws", async () => {
    const del = vi.fn(async () => true);
    vi.stubGlobal("caches", { default: { match: vi.fn(), put: vi.fn(), delete: del } });
    try {
      recomputeBucketSlots.mockRejectedValueOnce(new Error("refused"));
      await expect(recomputeBucketSlotsForToday("411", true)).rejects.toThrow("refused");
      expect(del).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("computes over the SEARCH window for the loaded org-wide horizon", async () => {
    await recomputeBucketSlotsForToday("411", true);
    expect(windowDays(recomputeBucketSlots.mock.calls[0])).toBe(searchWindowDays(7));
  });

  it("hands the horizon down as the trim target, not just as the window", async () => {
    await recomputeBucketSlotsForToday("411", true);
    expect(trimTarget(recomputeBucketSlots.mock.calls[0])).toBe(7);
  });

  it("computes WIDER than the days it will offer, so a closed day cannot eat one", async () => {
    await recomputeBucketSlotsForToday("411", true);
    const call = recomputeBucketSlots.mock.calls[0];
    expect(windowDays(call)).toBeGreaterThan(trimTarget(call)!);
  });

  it("uses an explicitly passed horizon without reading the setting", async () => {
    await recomputeBucketSlotsForToday("411", true, undefined, 3);
    expect(windowDays(recomputeBucketSlots.mock.calls[0])).toBe(searchWindowDays(3));
    expect(trimTarget(recomputeBucketSlots.mock.calls[0])).toBe(3);
    expect(loadBookingHorizonDays).not.toHaveBeenCalled();
  });
});

// The reads only arm moved to the pool coalescer (#3293 review) and is pinned in
// slot-cache-booking-refresh.test.ts.

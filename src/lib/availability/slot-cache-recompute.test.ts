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
const loadBucketSlotInputs = vi.hoisted(() => vi.fn(async () => null));
vi.mock("./service", () => ({ getBucketSlots: vi.fn(), loadBucketSlotInputs }));
const loadBookingHorizonDays = vi.hoisted(() => vi.fn(async () => 7));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays }));

import { recomputeBucketSlotsForToday, readBucketSlotInputsForToday } from "./slot-cache";
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

// #3258: the load run's reads-only arm makes the recompute's READS, over the same
// window, and nothing else: no compute and no row write, since a row built without
// the compute would be served to leads as if it were real.
describe("readBucketSlotInputsForToday", () => {
  beforeEach(() => {
    recomputeBucketSlots.mockClear();
    loadBucketSlotInputs.mockClear();
    loadBookingHorizonDays.mockClear();
    loadBookingHorizonDays.mockResolvedValue(7);
  });

  it("reads over the same search window the recompute computes over", async () => {
    await readBucketSlotInputsForToday("312");
    expect(loadBucketSlotInputs).toHaveBeenCalledTimes(1);
    const call = loadBucketSlotInputs.mock.calls[0] as unknown[];
    expect(call[0]).toBe("312");
    expect(windowDays(call)).toBe(searchWindowDays(7));
    await recomputeBucketSlotsForToday("313", true);
    const recompute = recomputeBucketSlots.mock.calls[0] as unknown[];
    expect([call[1], call[2]]).toEqual([recompute[1], recompute[2]]);
  });

  it("never computes or writes a row", async () => {
    await readBucketSlotInputsForToday("412");
    expect(recomputeBucketSlots).not.toHaveBeenCalled();
  });

  it("shares the recompute's per code debounce, so it runs exactly as often as the arm it stands in for", async () => {
    await readBucketSlotInputsForToday("512");
    await readBucketSlotInputsForToday("512");
    expect(loadBucketSlotInputs).toHaveBeenCalledTimes(1);
    await readBucketSlotInputsForToday("511");
    expect(loadBucketSlotInputs).toHaveBeenCalledTimes(2);
  });
});

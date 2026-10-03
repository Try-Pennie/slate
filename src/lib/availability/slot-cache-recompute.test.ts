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
vi.mock("./service", () => ({ getBucketSlots: vi.fn() }));
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

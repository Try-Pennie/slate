import { describe, it, expect, vi, beforeEach } from "vitest";

// #216: recomputeBucketSlotsForToday must compute the precomputed row over the
// runtime org-wide horizon (store > env > default), so raising the horizon makes
// rows actually SPAN more days (and lowering it bounds them). The read path is
// untouched; only the write window tracks the horizon. IO is fully mocked.

const recomputeBucketSlots = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./precompute", () => ({
  recomputeBucketSlots,
  readBucketSlotsRow: vi.fn(),
  writeBucketSlotsRow: vi.fn(),
  bucketsForAgent: vi.fn(async () => []),
}));
vi.mock("./service", () => ({ getBucketSlots: vi.fn() }));
const loadBookingHorizonDays = vi.hoisted(() => vi.fn(async () => 7));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays }));

import { recomputeBucketSlotsForToday } from "./slot-cache";

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

  it("computes the row over the loaded org-wide horizon", async () => {
    await recomputeBucketSlotsForToday("411", true);
    expect(windowDays(recomputeBucketSlots.mock.calls[0])).toBe(7);
  });

  it("uses an explicitly passed horizon without reading the setting", async () => {
    await recomputeBucketSlotsForToday("411", true, undefined, 3);
    expect(windowDays(recomputeBucketSlots.mock.calls[0])).toBe(3);
    expect(loadBookingHorizonDays).not.toHaveBeenCalled();
  });
});

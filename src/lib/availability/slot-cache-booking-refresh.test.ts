import { describe, it, expect, vi, beforeEach } from "vitest";

// #3258: the refresh a booking schedules after its response computes the booked
// code's whole POOL once, writes every code in it, and shares that compute with
// the pool's other bookings inside the coalescing window. The coalescing rule is
// pinned offline in scripts/test-pool-refresh-coalescer.ts; these pin the wiring:
// the real pool grouping, the row writes, and that a refresh which stored nothing
// FAILS rather than reading as done.

const precompute = vi.hoisted(() => ({
  bucketsForAgent: vi.fn(async (): Promise<string[]> => []),
  listPoolBuckets: vi.fn(async (): Promise<unknown[]> => []),
  computeBucketSlotsForWindow: vi.fn(async (code: string): Promise<unknown> => ({
    bucket: { code },
    eventType: { id: "event-1" },
    orgName: "Pennie",
    slots: ["2026-10-05T14:00:00.000Z"],
  })),
  writeBucketSlotsRow: vi.fn(async () => {}),
  storeBucketSlotsRow: vi.fn(async (_code: string, _val: unknown, _atMs: number) => "written" as const),
  recomputeBucketSlots: vi.fn(async () => {}),
  readBucketSlotsRow: vi.fn(),
  touchedBucketCodes: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock("./precompute", () => precompute);
vi.mock("./service", () => ({ getBucketSlots: vi.fn(), loadBucketSlotInputs: vi.fn() }));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 4) }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log }));

import { refreshPoolAfterBooking } from "./slot-cache";

function pooled(code: string, debtTeam: string) {
  return {
    code,
    bucket: { id: `id-${code}`, code },
    orgId: "org-1",
    eventTypeId: "event-1",
    criteria: { debt_team: debtTeam },
    fallbackUserId: null,
    memberIds: [],
  };
}
const LOW = ["111", "112"].map((c) => pooled(c, "low"));
const MID = ["211", "212"].map((c) => pooled(c, "mid"));

let clockMs = Date.parse("2026-10-05T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  // The coalescing window is module state, so each case starts well past it.
  clockMs += 10 * 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clockMs);
  precompute.listPoolBuckets.mockResolvedValue([...LOW, ...MID]);
});

describe("refreshPoolAfterBooking (#3258)", () => {
  it("computes the booked code's pool ONCE and writes every code in it", async () => {
    await refreshPoolAfterBooking("212");
    expect(precompute.computeBucketSlotsForWindow).toHaveBeenCalledTimes(1);
    const written = precompute.storeBucketSlotsRow.mock.calls.map((c) => c[0]).sort();
    expect(written).toEqual(["211", "212"]);
  });

  it("never touches another pool", async () => {
    await refreshPoolAfterBooking("112");
    const written = precompute.storeBucketSlotsRow.mock.calls.map((c) => c[0]).sort();
    expect(written).toEqual(["111", "112"]);
  });

  it("fails loud when the compute stored nothing, so the deferred job logs it", async () => {
    precompute.computeBucketSlotsForWindow.mockResolvedValueOnce(null);
    await expect(refreshPoolAfterBooking("211")).rejects.toThrow(/stored no rows/);
  });

  it("does nothing, and says so, for a code that names no bucket", async () => {
    await expect(refreshPoolAfterBooking("999")).resolves.toBeUndefined();
    expect(precompute.computeBucketSlotsForWindow).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});

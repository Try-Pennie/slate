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
const service = vi.hoisted(() => ({ getBucketSlots: vi.fn(), loadBucketSlotInputs: vi.fn(async () => null) }));
vi.mock("./service", () => service);
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 4) }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log }));

import { refreshPoolAfterBooking, readPoolInputsAfterBooking } from "./slot-cache";
import { searchWindowDays } from "./bookable-days";

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
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
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

// --- #3293 review ---------------------------------------------------------------------
describe("the coalesced refresh is never bound to one requester's code (#3293 review)", () => {
  it("a joiner whose code is still in the pool gets it refreshed after the first code moved away", async () => {
    // 211 leads and computes the mid pool at once.
    const first = refreshPoolAfterBooking("211");
    await vi.advanceTimersByTimeAsync(0);
    await first;
    precompute.storeBucketSlotsRow.mockClear();
    // Inside the window: 211 books again and 212 books. Before the trailing refresh
    // runs, 211 is moved into the low pool by an admin.
    const a = refreshPoolAfterBooking("211");
    const b = refreshPoolAfterBooking("212");
    const moved = [...LOW, pooled("211", "low"), MID[1]!];
    precompute.listPoolBuckets.mockResolvedValue(moved);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([a, b]);
    const written = precompute.storeBucketSlotsRow.mock.calls.map((c) => c[0]).sort();
    expect(written).toContain("212");
    expect(written).toContain("211");
  });

  it("a code from a bucket created after the pool grouping was cached is still refreshed", async () => {
    await refreshPoolAfterBooking("112"); // caches the grouping without 113
    precompute.storeBucketSlotsRow.mockClear();
    precompute.listPoolBuckets.mockResolvedValue([...LOW, pooled("113", "new"), ...MID]);
    await refreshPoolAfterBooking("113");
    const written = precompute.storeBucketSlotsRow.mock.calls.map((c) => c[0]);
    expect(written).toEqual(["113"]);
  });
});

describe("the reads only arm goes through the same pool coalescing (#3293 review)", () => {
  it("reads once per pool per window, like the on arm computes, and never writes", async () => {
    service.loadBucketSlotInputs.mockClear();
    const first = readPoolInputsAfterBooking("211");
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(service.loadBucketSlotInputs).toHaveBeenCalledTimes(1);
    // The representative code's reads over the same search window the on arm's pool
    // compute uses (searchWindowDays of the loaded horizon).
    const call = service.loadBucketSlotInputs.mock.calls[0] as unknown as [string, string, string];
    expect(call[0]).toBe("211");
    expect(Math.round((Date.parse(call[2]) - Date.parse(call[1])) / 86_400_000)).toBe(searchWindowDays(4));
    const a = readPoolInputsAfterBooking("212");
    const b = readPoolInputsAfterBooking("211");
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([a, b]);
    expect(service.loadBucketSlotInputs).toHaveBeenCalledTimes(2);
    expect(precompute.storeBucketSlotsRow).not.toHaveBeenCalled();
    expect(precompute.computeBucketSlotsForWindow).not.toHaveBeenCalled();
  });
});

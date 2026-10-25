import { describe, it, expect, vi, beforeEach } from "vitest";

// #3388: the WIRING of the eligibility read time into the pooled recompute's stamp.
// `scripts/test-recompute-eligibility-stamp.ts` drives the rule itself end to end
// (cache, pool recompute and the compare and swap); this pins that
// `recomputePoolSlotsForToday` actually hands the dated reader to the compute and
// the read time to the row write, and that a caller with no reader (every live
// path) still stamps from the compute's start.

const precompute = vi.hoisted(() => ({
  computeBucketSlotsForWindow: vi.fn(
    async (code: string, _from: string, _to: string, _resolve?: (b: unknown) => Promise<unknown>) => ({
      bucket: { code },
      eventType: { id: "event-1" },
      orgName: "Pennie",
      slots: ["2026-10-23T15:00:00.000Z"],
    }),
  ),
  storeBucketSlotsRow: vi.fn(
    async (_code: string, _val: unknown, _atMs: number, _by: string, _startedAtMs?: number) => "written" as const,
  ),
  writeBucketSlotsRow: vi.fn(),
  recomputeBucketSlots: vi.fn(),
  readBucketSlotsRow: vi.fn(),
  bucketsForAgent: vi.fn(),
  listPoolBuckets: vi.fn(),
  touchedBucketCodes: vi.fn(),
}));
vi.mock("./precompute", () => precompute);
vi.mock("./service", () => ({ getBucketSlots: vi.fn() }));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 4) }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log }));

import { recomputePoolSlotsForToday } from "./slot-cache";

const NOW = Date.parse("2026-10-23T14:00:00.000Z");

function pooled(code: string) {
  return {
    code,
    bucket: { id: `id-${code}`, code },
    orgId: "org-1",
    eventTypeId: "event-1",
    criteria: { debt_team: "low" },
    fallbackUserId: null,
    memberIds: [],
  };
}
const POOL = ["100", "101"].map(pooled) as unknown as Parameters<typeof recomputePoolSlotsForToday>[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

describe("recomputePoolSlotsForToday stamps from the eligibility read (#3388)", () => {
  it("stamps every code's row from a cached read older than the compute's start, and logs the lag", async () => {
    precompute.computeBucketSlotsForWindow.mockImplementationOnce(async (code, _f, _t, resolve) => {
      // The compute resolves eligibility through whatever it was handed, as the real one does.
      await resolve!({ id: `id-${code}` });
      return { bucket: { code }, eventType: { id: "event-1" }, orgName: "Pennie", slots: [] };
    });
    const read = vi.fn(async () => ({ agents: { ids: ["a1"], fallbackApplied: false }, readAtMs: NOW - 50_000 }));

    await recomputePoolSlotsForToday(POOL, "lane", read, 4);

    expect(read).toHaveBeenCalledTimes(1);
    // The stamp is the read; the start goes beside it for the lane's scheduling.
    expect(precompute.storeBucketSlotsRow.mock.calls.map((c) => [c[0], c[2], c[4]])).toEqual([
      ["100", NOW - 50_000, NOW],
      ["101", NOW - 50_000, NOW],
    ]);
    expect(log.info).toHaveBeenCalledWith("slot-cache", {
      msg: "pool stamped from its eligibility read",
      pool: "100",
      lag_ms: 50_000,
    });
  });

  it("stamps from the compute's start when no reader is passed, as every live path does", async () => {
    await recomputePoolSlotsForToday(POOL, "push", undefined, 4);

    // The compute was handed no resolver, so it reads eligibility live.
    expect(precompute.computeBucketSlotsForWindow.mock.calls[0]![3]).toBeUndefined();
    expect(precompute.storeBucketSlotsRow.mock.calls.map((c) => [c[2], c[4]])).toEqual([
      [NOW, NOW],
      [NOW, NOW],
    ]);
    expect(log.info).not.toHaveBeenCalledWith("slot-cache", expect.objectContaining({ msg: "pool stamped from its eligibility read" }));
  });

  it("keeps the start when the reader's answer is newer than it", async () => {
    precompute.computeBucketSlotsForWindow.mockImplementationOnce(async (code, _f, _t, resolve) => {
      await resolve!({ id: `id-${code}` });
      return { bucket: { code }, eventType: { id: "event-1" }, orgName: "Pennie", slots: [] };
    });
    const read = vi.fn(async () => ({ agents: { ids: ["a1"], fallbackApplied: false }, readAtMs: NOW + 2_000 }));

    await recomputePoolSlotsForToday(POOL, "lane", read, 4);

    expect(precompute.storeBucketSlotsRow.mock.calls.map((c) => c[2])).toEqual([NOW, NOW]);
  });
});

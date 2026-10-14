import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3258: the refresh a booking schedules after its response computes the booked
// code's whole POOL once, writes every code in it, and shares that compute with
// the pool's other bookings inside the coalescing window. The coalescing rule is
// pinned offline in scripts/test-pool-refresh-coalescer.ts; these pin the wiring:
// the real pool grouping, the row writes, and that a refresh which stored nothing
// FAILS rather than reading as done.

const precompute = vi.hoisted(() => ({
  bucketsForAgent: vi.fn(async (_userId?: string): Promise<string[]> => []),
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

import {
  refreshPoolOf,
  readPoolInputsAfterBooking,
  resetBookingRefreshesForTests,
  refreshAgentPoolsAfterPush,
  MAX_PUSH_POOLS_PER_CALL,
} from "./slot-cache";
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
  // The coalescers, the pool key cache and the start map are module state: each
  // case starts from none of it rather than relying on the clock to age it out.
  resetBookingRefreshesForTests();
  clockMs += 10 * 60_000;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  vi.setSystemTime(clockMs);
  precompute.listPoolBuckets.mockResolvedValue([...LOW, ...MID]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("refreshPoolOf (#3258)", () => {
  it("computes the booked code's pool ONCE and writes every code in it", async () => {
    await refreshPoolOf("212", "booking");
    expect(precompute.computeBucketSlotsForWindow).toHaveBeenCalledTimes(1);
    const written = precompute.storeBucketSlotsRow.mock.calls.map((c) => c[0]).sort();
    expect(written).toEqual(["211", "212"]);
  });

  it("never touches another pool", async () => {
    await refreshPoolOf("112", "booking");
    const written = precompute.storeBucketSlotsRow.mock.calls.map((c) => c[0]).sort();
    expect(written).toEqual(["111", "112"]);
  });

  it("fails loud when the compute stored nothing, so the deferred job logs it", async () => {
    precompute.computeBucketSlotsForWindow.mockResolvedValueOnce(null);
    await expect(refreshPoolOf("211", "booking")).rejects.toThrow(/stored no rows/);
  });

  // #3293 review: a refresh that refreshed NOTHING is a failure, so afterResponse
  // records it, never a quiet success.
  it("rejects when none of its codes is in any pool, after saying which", async () => {
    await expect(refreshPoolOf("999", "booking")).rejects.toThrow(/999/);
    expect(precompute.computeBucketSlotsForWindow).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("still succeeds when some of its codes were refreshed and one was in no pool", async () => {
    const lead = refreshPoolOf("212", "booking");
    await vi.advanceTimersByTimeAsync(0);
    await lead;
    // 211 and 212 join one trailing refresh of the mid pool; before it runs, 211's
    // bucket is deleted, so only 212 can be refreshed.
    const a = refreshPoolOf("211", "booking");
    const b = refreshPoolOf("212", "booking");
    precompute.listPoolBuckets.mockResolvedValue([...LOW, MID[1]!]);
    precompute.storeBucketSlotsRow.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(Promise.all([a, b])).resolves.toBeDefined();
    expect(precompute.storeBucketSlotsRow.mock.calls.map((c) => c[0])).toEqual(["212"]);
    expect(log.warn).toHaveBeenCalledWith("slot-cache", expect.objectContaining({ bucket: "211" }));
  });

  it("remembers a code in no pool for the cache's lifetime instead of re-reading every booking", async () => {
    await refreshPoolOf("112", "booking"); // caches the grouping
    const reads0 = precompute.listPoolBuckets.mock.calls.length;
    await refreshPoolOf("999", "booking").catch(() => {});
    // The first miss re-reads the grouping once, and the refresh reads the live buckets.
    expect(precompute.listPoolBuckets.mock.calls.length - reads0).toBe(2);
    const reads1 = precompute.listPoolBuckets.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000); // past the window, inside the cache's minute
    await refreshPoolOf("999", "booking").catch(() => {});
    // Only the refresh's own live read: the key lookup remembered 999 was missing.
    expect(precompute.listPoolBuckets.mock.calls.length - reads1).toBe(1);
  });

});

// --- #3293 review ---------------------------------------------------------------------
describe("the coalesced refresh is never bound to one requester's code (#3293 review)", () => {
  it("a joiner whose code is still in the pool gets it refreshed after the first code moved away", async () => {
    // 211 leads and computes the mid pool at once.
    const first = refreshPoolOf("211", "booking");
    await vi.advanceTimersByTimeAsync(0);
    await first;
    precompute.storeBucketSlotsRow.mockClear();
    // Inside the window: 211 books again and 212 books. Before the trailing refresh
    // runs, 211 is moved into the low pool by an admin.
    const a = refreshPoolOf("211", "booking");
    const b = refreshPoolOf("212", "booking");
    const moved = [...LOW, pooled("211", "low"), MID[1]!];
    precompute.listPoolBuckets.mockResolvedValue(moved);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([a, b]);
    const written = precompute.storeBucketSlotsRow.mock.calls.map((c) => c[0]).sort();
    expect(written).toContain("212");
    expect(written).toContain("211");
  });

  it("a code from a bucket created after the pool grouping was cached is still refreshed", async () => {
    await refreshPoolOf("112", "booking"); // caches the grouping without 113
    precompute.storeBucketSlotsRow.mockClear();
    precompute.listPoolBuckets.mockResolvedValue([...LOW, pooled("113", "new"), ...MID]);
    await refreshPoolOf("113", "booking");
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

// #3258 follow up: the reset must clear the reads only arm's start times too. They
// lived in an anonymous map the reset could not reach, so a case that read a pool
// left it inside the window for the next case, whose read then waited it out.
describe("resetBookingRefreshesForTests clears the reads only arm (#3258)", () => {
  it("a read right after a reset starts at once rather than waiting out the last case's window", async () => {
    const first = readPoolInputsAfterBooking("211");
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(service.loadBucketSlotInputs).toHaveBeenCalledTimes(1);
    resetBookingRefreshesForTests();
    const second = readPoolInputsAfterBooking("211");
    await vi.advanceTimersByTimeAsync(0);
    expect(service.loadBucketSlotInputs).toHaveBeenCalledTimes(2);
    await second;
  });
});

// #3258: the Google push path's refresh, measured in production at two thirds of
// the Worker's CPU beside every lead facing confirm timeout, goes through the SAME
// per pool coalescing as the booking refresh, and is bounded per push.
describe("refreshAgentPoolsAfterPush (#3258)", () => {
  const HIGH = ["311", "312"].map((c) => pooled(c, "high"));

  it("shares the booking refresh's window: a push right after a booking computes nothing of its own yet", async () => {
    precompute.bucketsForAgent.mockResolvedValue(["211"]);
    const booking = refreshPoolOf("212", "booking");
    await vi.advanceTimersByTimeAsync(0);
    await booking;
    expect(precompute.computeBucketSlotsForWindow).toHaveBeenCalledTimes(1);
    const push = refreshAgentPoolsAfterPush("agent-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(precompute.computeBucketSlotsForWindow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await push;
    expect(precompute.computeBucketSlotsForWindow).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ refreshed: 1, deferred: 0, failed: 0, debounced: 0 });
  });

  it("computes at most MAX_PUSH_POOLS_PER_CALL pools and leaves the rest to the recompute lane", async () => {
    precompute.listPoolBuckets.mockResolvedValue([...LOW, ...MID, ...HIGH]);
    precompute.bucketsForAgent.mockResolvedValue(["111", "211", "311"]);
    const push = refreshAgentPoolsAfterPush("agent-1");
    await vi.advanceTimersByTimeAsync(0);
    const out = await push;
    expect(MAX_PUSH_POOLS_PER_CALL).toBeLessThan(3);
    expect(precompute.computeBucketSlotsForWindow).toHaveBeenCalledTimes(MAX_PUSH_POOLS_PER_CALL);
    expect(out).toEqual({ refreshed: MAX_PUSH_POOLS_PER_CALL, deferred: 3 - MAX_PUSH_POOLS_PER_CALL, failed: 0, debounced: 0 });
    expect(log.info).toHaveBeenCalledWith(
      "slot-cache",
      expect.objectContaining({ msg: "agent pools refreshed after push", deferred: 3 - MAX_PUSH_POOLS_PER_CALL }),
    );
  });

  // #3302 lessons review: the bound must not starve the same pools forever.
  it("rotates which pools a bounded push refreshes, so every pool gets its turn", async () => {
    precompute.listPoolBuckets.mockResolvedValue([...LOW, ...MID, ...HIGH]);
    precompute.bucketsForAgent.mockResolvedValue(["111", "211", "311"]);
    const seen = new Set<string>();
    const picks: string[] = [];
    for (let i = 0; i < 3; i++) {
      precompute.storeBucketSlotsRow.mockClear();
      const push = refreshAgentPoolsAfterPush("agent-1");
      await vi.advanceTimersByTimeAsync(0);
      await push;
      // The tier digit names the pool here: LOW is 1xx, MID 2xx, HIGH 3xx.
      const pools = [...new Set(precompute.storeBucketSlotsRow.mock.calls.map((c) => String(c[0]).charAt(0)))].sort();
      picks.push(pools.join(","));
      pools.forEach((tier) => seen.add(tier));
      await vi.advanceTimersByTimeAsync(20_000); // past the window, so nothing joins
    }
    expect([...seen].sort()).toEqual(["1", "2", "3"]);
    expect(new Set(picks).size).toBeGreaterThan(1);
  });

  // #3302 advisory review: one isolate wide counter, stepped by pushes from agents
  // with different pool counts, can leave one agent's offset stuck. Three agents
  // interleaved step it by three a round, which pins an agent with three pools to
  // the same two forever. Rotation is per agent.
  it("covers every pool of an agent when pushes from agents with different pool counts interleave", async () => {
    precompute.listPoolBuckets.mockResolvedValue([...LOW, ...MID, ...HIGH]);
    const pools: Record<string, string[]> = {
      "agent-1": ["111", "211", "311"],
      "agent-2": ["111", "211"],
      "agent-3": ["311"],
    };
    precompute.bucketsForAgent.mockImplementation(async (userId?: string) => pools[userId ?? ""] ?? []);
    const seen = new Set<string>();
    for (let round = 0; round < 3; round++) {
      for (const agent of ["agent-1", "agent-2", "agent-3"]) {
        precompute.storeBucketSlotsRow.mockClear();
        const push = refreshAgentPoolsAfterPush(agent);
        await vi.advanceTimersByTimeAsync(0);
        await push;
        if (agent === "agent-1") {
          precompute.storeBucketSlotsRow.mock.calls.forEach((c) => seen.add(String(c[0]).charAt(0)));
        }
        await vi.advanceTimersByTimeAsync(20_000);
      }
    }
    expect([...seen].sort()).toEqual(["1", "2", "3"]);
  });

  it("never throws: a failed pool is counted and the push carries on", async () => {
    precompute.bucketsForAgent.mockResolvedValue(["211"]);
    precompute.computeBucketSlotsForWindow.mockResolvedValueOnce(null);
    const push = refreshAgentPoolsAfterPush("agent-1");
    await vi.advanceTimersByTimeAsync(0);
    await expect(push).resolves.toEqual({ refreshed: 0, deferred: 0, failed: 1, debounced: 0 });
  });

  it("answers null, and logs, when the agent's buckets cannot be read", async () => {
    precompute.bucketsForAgent.mockRejectedValueOnce(new Error("users read refused"));
    await expect(refreshAgentPoolsAfterPush("agent-1")).resolves.toBeNull();
    expect(log.error).toHaveBeenCalled();
  });
});

// #3381: every row a refresh writes names the path that wrote it, and a refresh several
// paths shared names all of them. On 2026-10-14 a row offered a time nobody was free
// for and two writers had run that second; the row is the only place left to ask.
describe("the rows a refresh writes name their writer (#3381)", () => {
  const writers = () => [...new Set(precompute.storeBucketSlotsRow.mock.calls.map((c) => (c as unknown[])[3]))];

  it("a booking's refresh is the booking's", async () => {
    await refreshPoolOf("212", "booking");
    expect(writers()).toEqual(["booking"]);
  });

  it("a refusal's refresh is the refusal's", async () => {
    await refreshPoolOf("212", "refusal");
    expect(writers()).toEqual(["refusal"]);
  });

  it("a push's refresh is the push's", async () => {
    precompute.bucketsForAgent.mockResolvedValue(["211"]);
    const push = refreshAgentPoolsAfterPush("agent-1");
    await vi.advanceTimersByTimeAsync(0);
    await push;
    expect(writers()).toEqual(["push"]);
  });

  it("a refresh a booking, a refusal and a push shared names all three, once each", async () => {
    const lead = refreshPoolOf("212", "booking");
    await vi.advanceTimersByTimeAsync(0);
    await lead;
    precompute.storeBucketSlotsRow.mockClear();
    precompute.bucketsForAgent.mockResolvedValue(["211"]);
    const joined = [refreshPoolOf("211", "refusal"), refreshPoolOf("212", "booking"), refreshAgentPoolsAfterPush("agent-1")];
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(joined);
    expect(writers()).toEqual(["booking+push+refusal"]);
  });
});

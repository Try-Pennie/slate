import { describe, it, expect, vi, beforeEach } from "vitest";

// #2922: an agent's slot refresh (the push and OOO paths) runs after the response,
// where Cloudflare cancels work 30 seconds after it ends. It used to recompute every
// bucket CODE the agent is in, one after another, at about four seconds each, so an
// agent in eight codes was cut off on almost every push. These tests pin the real
// wiring, not just the pure helper: the agent's codes are grouped into pools from the
// live bucket list, ONE compute runs per pool, every code in each pool gets its row,
// the finished refresh logs a line that can be counted, and a failure to work out
// the agent's buckets is logged and reported as null rather than as zero work.

const precompute = vi.hoisted(() => ({
  bucketsForAgent: vi.fn(async (_userId: string): Promise<string[]> => []),
  listPoolBuckets: vi.fn(async (): Promise<unknown[]> => []),
  computeBucketSlotsForWindow: vi.fn(async (code: string) => ({
    bucket: { code },
    eventType: { id: "event-1" },
    orgName: "Pennie",
    slots: ["2026-10-01T14:00:00.000Z"],
  })),
  writeBucketSlotsRow: vi.fn(async (_code: string, _val: unknown, _atMs: number) => {}),
  storeBucketSlotsRow: vi.fn(async (_code: string, _val: unknown, _atMs: number) => "written" as const),
  recomputeBucketSlots: vi.fn(async () => {}),
  readBucketSlotsRow: vi.fn(),
  touchedBucketCodes: vi.fn(async (_ids: string[], _max: number, _label: string): Promise<string[]> => []),
}));
vi.mock("./precompute", () => precompute);
vi.mock("./service", () => ({ getBucketSlots: vi.fn() }));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 4) }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log }));

import {
  recomputeBucketsForAgent,
  recomputePoolsForCodes,
  refreshPoolsForAgents,
  MAX_TOUCHED_POOLS_PER_SWEEP,
} from "./slot-cache";

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

const LOW = ["100", "101", "102", "110", "111", "112"].map((c) => pooled(c, "low"));
const MID = ["200", "201", "210"].map((c) => pooled(c, "mid"));
const HIGH = ["300"].map((c) => pooled(c, "high"));

let clockMs = Date.parse("2026-10-01T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  // The pool debounce is module state, so each case starts well past it.
  clockMs += 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clockMs);
  precompute.listPoolBuckets.mockResolvedValue([...LOW, ...MID, ...HIGH]);
});

describe("recomputeBucketsForAgent refreshes by pool (#2922)", () => {
  it("computes once per pool the agent is in and writes every code in those pools", async () => {
    precompute.bucketsForAgent.mockResolvedValueOnce(["100", "110", "112", "200"]);

    const out = await recomputeBucketsForAgent("agent-1");

    expect(precompute.bucketsForAgent).toHaveBeenCalledWith("agent-1");
    expect(precompute.computeBucketSlotsForWindow).toHaveBeenCalledTimes(2);
    const written = precompute.storeBucketSlotsRow.mock.calls.map((c) => c[0]).sort();
    expect(written).toEqual([...LOW, ...MID].map((b) => b.code).sort());
    expect(out).toEqual({ refreshed: 2, deferred: 0, failed: 0, debounced: 0 });
  });

  // #3119: a database REFUSAL is an answer, not a throw. It used to be dropped, so
  // the refused code was counted as written and this warning never fired for it.
  it("names a code whose row the database refused, and does not count it as written", async () => {
    precompute.bucketsForAgent.mockResolvedValueOnce(["200"]);
    precompute.storeBucketSlotsRow.mockImplementation(async (code: string) =>
      code === "201" ? ("failed" as never) : "written",
    );
    try {
      await recomputeBucketsForAgent("agent-5");
    } finally {
      precompute.storeBucketSlotsRow.mockImplementation(async () => "written");
    }
    const warned = log.warn.mock.calls.filter(
      ([tag, fields]) => tag === "slot-cache" && fields.msg === "pooled slot write failed for some codes",
    );
    expect(warned).toHaveLength(1);
    expect(warned[0][1]).toMatchObject({ codes: "201" });
  });

  it("logs one countable line for the finished refresh", async () => {
    precompute.bucketsForAgent.mockResolvedValueOnce(["300"]);

    await recomputeBucketsForAgent("agent-2");

    const lines = log.info.mock.calls.filter(
      ([tag, fields]) => tag === "slot-cache" && fields.msg === "agent pools recomputed",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({ user_id: "agent-2", codes: 1, refreshed: 1, deferred: 0 });
  });

  it("reports null and logs the cause when the agent's buckets cannot be read", async () => {
    precompute.bucketsForAgent.mockRejectedValueOnce(new Error("buckets unreadable"));

    const out = await recomputeBucketsForAgent("agent-3");

    expect(out).toBeNull();
    expect(precompute.computeBucketSlotsForWindow).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("reports null when the pool listing cannot be read, rather than zero pools refreshed", async () => {
    precompute.bucketsForAgent.mockResolvedValueOnce(["100"]);
    precompute.listPoolBuckets.mockRejectedValueOnce(new Error("pool listing refused"));

    const out = await recomputeBucketsForAgent("agent-4");

    expect(out).toBeNull();
    expect(precompute.computeBucketSlotsForWindow).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

// #2357: the every minute callers (the sync lane's post sync refresh and both self
// heal reconcile sweeps) used to loop recomputeBucketSlotsForToday over up to twenty
// or twenty five CODES, one whole pool compute each, with no budget at all. On the
// load test Worker that tail ran to minutes and took a minute tick to 119 s of CPU
// against a 120 s kill. These pin that they now get one compute per pool, at most
// `maxPools` of them, and an honest null when the pools cannot be listed.
describe("recomputePoolsForCodes bounds a cron sweep's refresh (#2357)", () => {
  it("computes once per pool and never starts more pools than the count allows", async () => {
    const out = await recomputePoolsForCodes(["100", "110", "200", "300"], {
      label: "touched-bucket",
      maxPools: 2,
    });

    expect(precompute.computeBucketSlotsForWindow).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ refreshed: 2, deferred: 1, failed: 0, debounced: 0 });
    const lines = log.info.mock.calls.filter(
      ([tag, fields]) => tag === "slot-cache" && fields.msg === "touched pools recomputed",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({ label: "touched-bucket", codes: 4, refreshed: 2, deferred: 1 });
  });

  it("does no read at all when nothing was touched, the common tick", async () => {
    const out = await recomputePoolsForCodes([], { label: "reconcile", maxPools: 5 });

    expect(out).toEqual({ refreshed: 0, deferred: 0, failed: 0, debounced: 0 });
    expect(precompute.listPoolBuckets).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("reports null and logs the cause when the pools cannot be listed", async () => {
    precompute.listPoolBuckets.mockRejectedValueOnce(new Error("pool listing refused"));

    const out = await recomputePoolsForCodes(["100"], { label: "reconcile-missing", maxPools: 5 });

    expect(out).toBeNull();
    expect(precompute.computeBucketSlotsForWindow).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][1]).toMatchObject({ label: "reconcile-missing" });
  });

  it("counts a pool whose compute failed and carries on to the next", async () => {
    precompute.computeBucketSlotsForWindow.mockRejectedValueOnce(new Error("compute failed"));

    const out = await recomputePoolsForCodes(["100", "200"], { label: "touched-bucket", maxPools: 5 });

    expect(out).toEqual({ refreshed: 1, deferred: 0, failed: 1, debounced: 0 });
  });
});

// The one call the sync lane and both reconcile sweeps make (#2357), so the bound
// is applied by construction rather than remembered at three sites.
describe("refreshPoolsForAgents is the sweeps' whole refresh (#2357)", () => {
  it("looks up every code the agents touch, uncapped, and refreshes at most the sweep's pool count", async () => {
    // Seven single code pools, more than the sweep may start.
    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((t, i) => pooled(`9${i}0`, t));
    precompute.listPoolBuckets.mockResolvedValue(seven);
    precompute.touchedBucketCodes.mockResolvedValueOnce(seven.map((b) => b.code));

    const out = await refreshPoolsForAgents(["u1", "u2"], "reconcile");

    expect(precompute.touchedBucketCodes).toHaveBeenCalledWith(
      ["u1", "u2"],
      Number.POSITIVE_INFINITY,
      "reconcile",
    );
    expect(precompute.computeBucketSlotsForWindow).toHaveBeenCalledTimes(MAX_TOUCHED_POOLS_PER_SWEEP);
    expect(out).toEqual({
      refreshed: MAX_TOUCHED_POOLS_PER_SWEEP,
      deferred: 7 - MAX_TOUCHED_POOLS_PER_SWEEP,
      failed: 0,
      debounced: 0,
    });
  });

  it("reads nothing for a sweep that changed no agent", async () => {
    const out = await refreshPoolsForAgents([], "reconcile-missing");

    expect(out).toEqual({ refreshed: 0, deferred: 0, failed: 0, debounced: 0 });
    expect(precompute.touchedBucketCodes).not.toHaveBeenCalled();
    expect(precompute.listPoolBuckets).not.toHaveBeenCalled();
  });
});

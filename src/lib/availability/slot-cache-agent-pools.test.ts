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
  recomputeBucketSlots: vi.fn(async () => {}),
  readBucketSlotsRow: vi.fn(),
}));
vi.mock("./precompute", () => precompute);
vi.mock("./service", () => ({ getBucketSlots: vi.fn() }));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 4) }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log }));

import { recomputeBucketsForAgent } from "./slot-cache";

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
    const written = precompute.writeBucketSlotsRow.mock.calls.map((c) => c[0]).sort();
    expect(written).toEqual([...LOW, ...MID].map((b) => b.code).sort());
    expect(out).toEqual({ refreshed: 2, deferred: 0, failed: 0, debounced: 0 });
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

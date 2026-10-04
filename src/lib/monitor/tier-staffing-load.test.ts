import { describe, it, expect, vi, beforeEach } from "vitest";

// #3227: the alert_state reads and writes behind a debt tier page's recovery hold.
// The decision is pure and driven in scripts/test-tier-staffing.ts; this pins the
// IO: which rows are read, that a refused read throws rather than answering
// empty, that an unreadable stamp means not holding, and that a refused write is
// logged by name rather than swallowed.

const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => admin);
const logs = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/log", () => logs);
const dispatch = vi.hoisted(() => ({
  firingKey: (k: string) => `alert_firing:${k}`,
  mayWriteAlerts: vi.fn(() => true),
}));
vi.mock("@/lib/notify/dispatch", () => dispatch);

import { clearTierHolds, loadTierAlertState, startTierHolds } from "./tier-staffing-load";

type Result = { data: unknown; error: { message: string } | null };

function fakeDb(result: Result) {
  const calls = { inKeys: [] as string[][], upserts: [] as unknown[], deletes: [] as string[][] };
  const db = {
    from: (table: string) => {
      expect(table).toBe("alert_state");
      return {
        select: () => ({
          in: (_col: string, keys: string[]) => {
            calls.inKeys.push(keys);
            return Promise.resolve(result);
          },
        }),
        upsert: (rows: unknown) => {
          calls.upserts.push(rows);
          return Promise.resolve({ error: result.error });
        },
        delete: () => ({
          in: (_col: string, keys: string[]) => {
            calls.deletes.push(keys);
            return Promise.resolve({ error: result.error });
          },
        }),
      };
    },
  };
  admin.supabaseAdmin.mockReturnValue(db);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatch.mayWriteAlerts.mockReturnValue(true);
});

describe("loadTierAlertState", () => {
  it("reads every tier's firing marker and hold in one read", async () => {
    const calls = fakeDb({
      data: [
        { key: "alert_firing:empty_tier:1", last_sent_at: "2026-10-04T16:45:00.000Z" },
        { key: "empty_tier_healthy_since:1", last_sent_at: "2026-10-04T17:35:00.000Z" },
        { key: "empty_tier_healthy_since:2", last_sent_at: "not a time" },
      ],
      error: null,
    });
    const state = await loadTierAlertState(["1", "2"]);
    expect(calls.inKeys).toHaveLength(1);
    expect(calls.inKeys[0].sort()).toEqual(
      ["alert_firing:empty_tier:1", "alert_firing:empty_tier:2", "empty_tier_healthy_since:1", "empty_tier_healthy_since:2"].sort(),
    );
    expect(state.readable).toBe(true);
    if (!state.readable) return;
    expect([...state.firing]).toEqual(["1"]);
    expect(state.holdSinceMs.get("1")).toBe(Date.parse("2026-10-04T17:35:00.000Z"));
    // An unreadable stamp is not a hold, so the next good tick starts it again
    // rather than clearing on a moment nobody can read.
    expect(state.holdSinceMs.has("2")).toBe(false);
  });

  it("throws on a refused read rather than answering that nothing is open", async () => {
    fakeDb({ data: null, error: { message: "permission denied" } });
    await expect(loadTierAlertState(["1"])).rejects.toThrow(/tier alert state read failed: permission denied/);
  });
});

describe("startTierHolds and clearTierHolds", () => {
  it("stamps each hold at the given moment and deletes by key", async () => {
    const calls = fakeDb({ data: null, error: null });
    await startTierHolds(["1", "3"], Date.parse("2026-10-04T17:35:00.000Z"));
    expect(calls.upserts[0]).toEqual([
      { key: "empty_tier_healthy_since:1", last_sent_at: "2026-10-04T17:35:00.000Z" },
      { key: "empty_tier_healthy_since:3", last_sent_at: "2026-10-04T17:35:00.000Z" },
    ]);
    await clearTierHolds(["1"]);
    expect(calls.deletes[0]).toEqual(["empty_tier_healthy_since:1"]);
  });

  it("writes nothing for no tiers", async () => {
    const calls = fakeDb({ data: null, error: null });
    await startTierHolds([], 0);
    await clearTierHolds([]);
    expect(calls.upserts).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
  });

  it("logs a refused write by name rather than swallowing it", async () => {
    fakeDb({ data: null, error: { message: "refused" } });
    await startTierHolds(["1"], 0);
    expect(logs.log.warn).toHaveBeenCalledWith(
      "monitor",
      expect.objectContaining({ msg: "tier recovery hold write failed", error: "refused" }),
    );
    await clearTierHolds(["1"]);
    expect(logs.log.error).toHaveBeenCalledWith(
      "monitor",
      expect.objectContaining({ msg: "tier recovery hold clear failed", error: "refused" }),
    );
  });

  it("writes nothing off the Workers runtime, like every other alert write", async () => {
    dispatch.mayWriteAlerts.mockReturnValue(false);
    const calls = fakeDb({ data: null, error: null });
    await startTierHolds(["1"], 0);
    await clearTierHolds(["1"]);
    expect(calls.upserts).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// #3109: the daily retention lane that prunes the Regal call feed also prunes
// rate_limits, as a third independent sweep. What is pinned here is the wiring:
// the plan reaches the database function, a refused prune fails the lane (so it
// stops stamping and the watchdog pages) without stopping the two Regal sweeps,
// and a null count from the function is a failure rather than "nothing to do".
// The plan itself and the SQL are pinned in scripts/test-rate-limit-prune.ts.

const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const db = vi.hoisted(() => {
  const state = {
    rpcResult: { data: 7 as number | null, error: null as { message: string } | null },
    rpcCalls: [] as Array<[string, Record<string, unknown>]>,
    deletedTables: [] as string[],
  };
  const from = vi.fn((table: string) => ({
    delete: () => ({
      lt: async () => {
        state.deletedTables.push(table);
        return { count: 3, error: null };
      },
    }),
  }));
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    state.rpcCalls.push([fn, args]);
    return state.rpcResult;
  });
  return { state, from, rpc };
});
const hb = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: db.from, rpc: db.rpc }) }));
vi.mock("@/lib/monitor/heartbeat", () => ({ recordHeartbeat: hb.recordHeartbeat }));
vi.mock("@/lib/notify/dispatch", () => ({
  sendThrottledAlert: vi.fn(async () => {}),
  resolveAlert: vi.fn(async () => true),
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";
import { rateLimitPrunePlan } from "@/lib/rate-limit-core";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  db.state.rpcResult = { data: 7, error: null };
  db.state.rpcCalls = [];
  db.state.deletedTables = [];
});

describe("GET /api/cron/prune-regal-calls: the rate_limits sweep (#3109)", () => {
  it("prunes rate_limits once per planned group, with its prefixes and age, and reports the count", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const plan = rateLimitPrunePlan();
    expect(plan.map((g) => g.name)).toEqual(["limiter", "window-counter"]);
    expect(db.state.rpcCalls).toEqual(
      plan.map((g) => ["prune_rate_limits", { p_prefixes: g.prefixes, p_older_than_seconds: g.olderThanSeconds }]),
    );
    const body = await res.json();
    expect(body.rateLimitsDeleted).toBe(14);
    expect(body.rateLimitsGroups.map((g: { name: string; deleted: number }) => [g.name, g.deleted])).toEqual([
      ["limiter", 7],
      ["window-counter", 7],
    ]);
    expect(hb.recordHeartbeat).toHaveBeenCalled();
  });

  it("fails the lane on a refused prune, and the Regal sweeps still run", async () => {
    db.state.rpcResult = { data: null, error: { message: "function prune_rate_limits does not exist" } };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/prune_rate_limits/);
    expect(db.state.deletedTables.sort()).toEqual(["regal_call_events", "regal_call_outcomes"]);
    expect(hb.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("reads a null count with no error as a failure, never as zero deleted", async () => {
    db.state.rpcResult = { data: null, error: null };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(hb.recordHeartbeat).not.toHaveBeenCalled();
  });
});

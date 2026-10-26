import { describe, it, expect, vi, beforeEach } from "vitest";

// #3109: the daily retention lane that prunes the Regal call feed also prunes
// rate_limits, as a third independent sweep. What is pinned here is the wiring:
// the plan reaches the database function, a refused prune fails the lane (so it
// stops stamping and the watchdog pages) without stopping the other sweeps,
// and a null count from the function is a failure rather than "nothing to do".
// The plan itself and the SQL are pinned in scripts/test-rate-limit-prune.ts.
//
// #4222 added a fourth sweep, the cron lanes' claims in lane_runs, with the same
// failure boundary, and the claim every scheduled lane makes before any work: a
// re-sent tick takes no lock, deletes nothing and stamps nothing.

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
    deletes: [] as Array<[string, string, string]>,
    laneRunsDelete: { count: 5 as number | null, error: null as { message: string } | null },
    claim: { error: null as { code?: string; message: string } | null },
    claims: [] as unknown[],
  };
  const from = vi.fn((table: string) => ({
    delete: () => ({
      lt: async (column: string, cutoff: string) => {
        state.deletedTables.push(table);
        state.deletes.push([table, column, cutoff]);
        return table === "lane_runs" ? state.laneRunsDelete : { count: 3, error: null };
      },
    }),
    insert: async (row: unknown) => {
      state.claims.push(row);
      return state.claim;
    },
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
  db.state.deletes = [];
  db.state.laneRunsDelete = { count: 5, error: null };
  db.state.claim = { error: null };
  db.state.claims = [];
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
    expect(db.state.deletedTables.sort()).toEqual(["lane_runs", "regal_call_events", "regal_call_outcomes"]);
    expect(hb.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("reads a null count with no error as a failure, never as zero deleted", async () => {
    db.state.rpcResult = { data: null, error: null };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(hb.recordHeartbeat).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/prune-regal-calls: the lane_runs sweep (#4222)", () => {
  it("prunes lane claims older than two days and reports the count", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-26T03:05:00Z"), toFake: ["Date"] });
    try {
      const res = await GET(req());
      expect(res.status).toBe(200);
      expect(db.state.deletes.filter(([t]) => t === "lane_runs")).toEqual([
        ["lane_runs", "claimed_at", "2026-10-24T03:05:00.000Z"],
      ]);
      const body = await res.json();
      expect(body.laneRunsDeleted).toBe(5);
      expect(body.laneRunsCutoff).toBe("2026-10-24T03:05:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the lane on a refused lane_runs delete, and the other sweeps still run", async () => {
    db.state.laneRunsDelete = { count: null, error: { message: 'relation "lane_runs" does not exist' } };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/lane_runs/);
    expect(db.state.deletedTables.sort()).toEqual(["lane_runs", "regal_call_events", "regal_call_outcomes"]);
    expect(db.state.rpcCalls.length).toBe(rateLimitPrunePlan().length);
    expect(hb.recordHeartbeat).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/prune-regal-calls: a re-sent tick does nothing (#4222)", () => {
  const tickReq = (id: string) =>
    ({ headers: new Headers({ "x-slate-tick-id": id }) }) as unknown as Parameters<typeof GET>[0];

  it("claims the tick, then runs", async () => {
    const res = await GET(tickReq("abc123"));
    expect(res.status).toBe(200);
    expect(db.state.claims).toEqual([{ tick_id: "abc123", lane: "prune_regal_calls" }]);
    expect(locks.acquireLock).toHaveBeenCalled();
  });

  it("answers a duplicate without taking the lock, deleting, or stamping", async () => {
    db.state.claim = { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    const res = await GET(tickReq("abc123"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-slate-lane-not-run")).toBe("duplicate");
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(db.state.deletedTables).toEqual([]);
    expect(db.state.rpcCalls).toEqual([]);
    expect(hb.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("runs a FIRST delivery whose claim cannot be read (Dan, 2026-10-26: never skip a run)", async () => {
    db.state.claim = { error: { code: "57014", message: "canceling statement due to statement timeout" } };
    const res = await GET(tickReq("abc123"));
    expect(res.status).toBe(200);
    expect(locks.acquireLock).toHaveBeenCalled();
    expect(db.state.deletedTables.sort()).toEqual(["lane_runs", "regal_call_events", "regal_call_outcomes"]);
  });

  it("runs nothing and answers 503 for a RE-SEND whose claim cannot be read", async () => {
    db.state.claim = { error: { code: "57014", message: "canceling statement due to statement timeout" } };
    const res = await GET({
      headers: new Headers({ "x-slate-tick-id": "abc123", "x-slate-lane-resend": "1" }),
    } as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(503);
    expect(res.headers.get("x-slate-lane-not-run")).toBe("claim_unreadable");
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(db.state.deletedTables).toEqual([]);
  });
});

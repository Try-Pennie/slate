import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring for the busy_blocks past-row prune (#1252). The pure batching core is
// covered by scripts/test-prune-busy-blocks.ts; this pins the parts only the route
// decides: WHICH rows it is allowed to touch, that a failed read or delete becomes a
// 500 rather than a cheerful "pruned 0", and that the heartbeat is stamped.
//
// The filter set is the safety property. Deleting a FUTURE block, or a block owned
// by a booking or by Slate itself, would remove busy time nothing puts back:
// incremental sync only reports changes, so a deleted far-future block is never
// re-added and the agent looks free during a real meeting.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const hb = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));
const db = vi.hoisted(() => {
  const state = {
    /** Successive pages the candidate read hands back. */
    pages: [] as string[][],
    /** When set, every read returns a FULL page, i.e. the backlog never runs out. */
    inexhaustible: false,
    readError: null as { message: string } | null,
    deleteError: null as { message: string } | null,
    deleteCount: null as number | null,
    deletedBatches: [] as string[][],
    eqCalls: [] as Array<[string, unknown]>,
    isCalls: [] as Array<[string, unknown]>,
    ltCalls: [] as Array<[string, string]>,
    orderCalls: [] as string[],
    limitCalls: [] as number[],
  };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    state.eqCalls.push([col, val]);
    return chain;
  };
  chain.is = (col: string, val: unknown) => {
    state.isCalls.push([col, val]);
    return chain;
  };
  chain.lt = (col: string, val: string) => {
    state.ltCalls.push([col, val]);
    return chain;
  };
  chain.order = (col: string) => {
    state.orderCalls.push(col);
    return chain;
  };
  chain.limit = (n: number) => {
    state.limitCalls.push(n);
    const page = state.inexhaustible
      ? Array.from({ length: n }, (_, i) => `row-${state.limitCalls.length}-${i}`)
      : (state.pages.shift() ?? []);
    return Promise.resolve({
      data: state.readError ? null : page.map((id) => ({ id })),
      error: state.readError,
    });
  };
  const del = () => ({
    in: (_col: string, ids: string[]) => {
      state.deletedBatches.push(ids);
      return Promise.resolve({
        error: state.deleteError,
        count: state.deleteError ? null : (state.deleteCount ?? ids.length),
      });
    },
  });
  const from = vi.fn(() => ({ ...chain, delete: del }));
  return { state, from };
});

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: db.from }) }));
vi.mock("@/lib/monitor/heartbeat", () => ({ recordHeartbeat: hb.recordHeartbeat }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";
import {
  BUSY_PRUNE_BATCH_ROWS,
  BUSY_PRUNE_KEEP_PAST_HOURS,
  BUSY_PRUNE_MAX_ROWS_PER_RUN,
} from "@/lib/busy/prune-core";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  db.state.pages = [];
  db.state.readError = null;
  db.state.deleteError = null;
  db.state.deleteCount = null;
  db.state.deletedBatches = [];
  db.state.eqCalls = [];
  db.state.isCalls = [];
  db.state.ltCalls = [];
  db.state.orderCalls = [];
  db.state.limitCalls = [];
});

describe("prune-busy-blocks cron (#1252)", () => {
  it("refuses an unauthorized caller", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("skips an overlapping run rather than double-pruning", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect(await res.json()).toEqual({ skipped: "overlapping-run" });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("only ever targets past gcal rows that no booking owns", async () => {
    db.state.pages = [["a", "b"]];
    await GET(req());
    // The whole safety argument for this lane, asserted rather than commented.
    expect(db.state.eqCalls).toContainEqual(["source", "gcal"]);
    expect(db.state.isCalls).toContainEqual(["booking_id", null]);
    const endsAtBound = db.state.ltCalls.find(([col]) => col === "ends_at");
    expect(endsAtBound).toBeDefined();
    // The cutoff is genuinely in the past by at least the keep-past window, so a
    // block that is merely finishing soon is never in scope.
    const cutoffMs = Date.parse(endsAtBound![1]);
    expect(Number.isFinite(cutoffMs)).toBe(true);
    expect(Date.now() - cutoffMs).toBeGreaterThanOrEqual(
      BUSY_PRUNE_KEEP_PAST_HOURS * 60 * 60_000 - 5_000,
    );
    // Oldest first, and bounded: busy_blocks is a growth table, so an unbounded
    // read would silently see only PostgREST's first page.
    expect(db.state.orderCalls).toContain("ends_at");
    expect(db.state.limitCalls.every((n) => n <= BUSY_PRUNE_BATCH_ROWS)).toBe(true);
  });

  it("reports what it pruned and that the backlog is clear", async () => {
    db.state.pages = [["a", "b", "c"]];
    const res = await GET(req());
    const body = await res.json();
    expect(body.pruned).toBe(3);
    expect(body.capped).toBe(false);
    expect(db.state.deletedBatches).toEqual([["a", "b", "c"]]);
    expect(hb.recordHeartbeat).toHaveBeenCalledWith("prune-busy-blocks");
  });

  it("stops at the per-run cap and says capped while rows remain", async () => {
    // A backlog that never runs out, which is the real starting state: 68,805 rows
    // were prunable on 2026-08-04 against a 30,000-row cap. The run must stop on its
    // own bound AND say it stopped early, because a capped run and a cleared table
    // otherwise look identical from the outside.
    db.state.inexhaustible = true;
    const res = await GET(req());
    const body = await res.json();
    expect(body.capped).toBe(true);
    expect(body.pruned).toBe(BUSY_PRUNE_MAX_ROWS_PER_RUN);
    expect(body.batches).toBe(BUSY_PRUNE_MAX_ROWS_PER_RUN / BUSY_PRUNE_BATCH_ROWS);
  });

  it("fails loud when the candidate read errors, instead of reporting nothing to prune", async () => {
    db.state.readError = { message: "column ends_at does not exist" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    // The dangerous outcome would be a 200 saying pruned 0, which is
    // indistinguishable from a table that is already clean.
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("ends_at") });
    expect(db.state.deletedBatches).toEqual([]);
  });

  it("fails loud when the delete errors, instead of scoring the null count as zero", async () => {
    db.state.pages = [["a"]];
    db.state.deleteError = { message: "permission denied" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("permission denied") });
    // #1165: a failed count-shaped delete must never surface as pruned 0.
    expect(hb.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("fails loud when a delete removes nothing while rows were selected", async () => {
    db.state.pages = [["a", "b"]];
    db.state.deleteCount = 0;
    const res = await GET(req());
    expect(res.status).toBe(500);
  });

  it("releases the lock even when the run throws", async () => {
    db.state.readError = { message: "boom" };
    await GET(req());
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_busy_blocks", "lease");
  });
});

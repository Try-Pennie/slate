import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring for the busy_blocks prune (#1252 past, #1265 future). The pure batching core
// is covered by scripts/test-prune-busy-blocks.ts; this pins the parts only the route
// decides: WHICH rows each clause is allowed to touch, that a failed read or delete
// becomes a 500 rather than a cheerful "pruned 0", and that the heartbeat is stamped.
//
// The filter set is the safety property. The PAST clause touches only finished gcal
// blocks no booking owns. The FUTURE clause (#1265) touches only blocks past the write
// window's keep boundary, and only for calendars hydrated past the gate, so no readable
// block (which needs starts_at < now + horizon) is ever in scope; before #1264's write
// filter shipped this was unsafe, because the delta would re-add a deleted far-future
// block.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const hb = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));
// withinBudget is controllable so a test can force the shared deadline to run out.
const pace = vi.hoisted(() => ({ withinBudget: vi.fn(() => true) }));
const db = vi.hoisted(() => {
  const state = {
    /** Successive pages the candidate read hands back. */
    pages: [] as string[][],
    /** When set, every PAST read returns a FULL page, i.e. the backlog never runs out. */
    inexhaustible: false,
    /** Same, but for the FUTURE read only, so a test can drain the past yet flood the future. */
    futureInexhaustible: false,
    readError: null as { message: string } | null,
    deleteError: null as { message: string } | null,
    deleteCount: null as number | null,
    deletedBatches: [] as string[][],
    /** Calendars the #1265 agent_calendars gate returns as eligible (default none). */
    eligible: [] as Array<{ user_id: string; calendar_id: string }>,
    /** Error for the #1265 agent_calendars gate read, kept apart from the past read. */
    eligibleError: null as { message: string } | null,
    /** Error for the FUTURE busy_blocks candidate read (starts_at >= cutoff), apart from past. */
    futureReadError: null as { message: string } | null,
    /** True once a `.gte` (future read) ran, false after a `.lt` (past read), so `.limit`
     *  can pick the right error without the two phases sharing one. */
    currentIsFuture: false,
    eqCalls: [] as Array<[string, unknown]>,
    isCalls: [] as Array<[string, unknown]>,
    ltCalls: [] as Array<[string, string]>,
    gtCalls: [] as Array<[string, string]>,
    gteCalls: [] as Array<[string, string]>,
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
    state.currentIsFuture = false;
    return chain;
  };
  // Terminal for the #1265 eligible-calendars read (agent_calendars .gt sync_window_to).
  chain.gt = (col: string, val: string) => {
    state.gtCalls.push([col, val]);
    return Promise.resolve({
      data: state.eligibleError ? null : state.eligible,
      error: state.eligibleError,
    });
  };
  // Mid-chain for the future busy_blocks read (starts_at >= cutoff).
  chain.gte = (col: string, val: string) => {
    state.gteCalls.push([col, val]);
    state.currentIsFuture = true;
    return chain;
  };
  chain.order = (col: string) => {
    state.orderCalls.push(col);
    return chain;
  };
  chain.limit = (n: number) => {
    state.limitCalls.push(n);
    // The future candidate read and the past one carry their own errors, so a test can
    // fail one phase while the other succeeds.
    const err = state.currentIsFuture ? state.futureReadError : state.readError;
    const endless = state.currentIsFuture ? state.futureInexhaustible : state.inexhaustible;
    const page = endless
      ? Array.from({ length: n }, (_, i) => `row-${state.limitCalls.length}-${i}`)
      : (state.pages.shift() ?? []);
    return Promise.resolve({
      data: err ? null : page.map((id) => ({ id })),
      error: err,
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
vi.mock("@/lib/google/sync-pace", () => pace);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";
import {
  BUSY_PRUNE_BATCH_ROWS,
  BUSY_PRUNE_KEEP_PAST_HOURS,
  BUSY_PRUNE_MAX_ROWS_PER_RUN,
} from "@/lib/busy/prune-core";
import { HORIZON_MAX } from "@/lib/booking/settings";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  db.state.pages = [];
  db.state.inexhaustible = false;
  db.state.futureInexhaustible = false;
  db.state.readError = null;
  db.state.deleteError = null;
  db.state.deleteCount = null;
  db.state.deletedBatches = [];
  db.state.eligible = [];
  db.state.eligibleError = null;
  db.state.futureReadError = null;
  db.state.currentIsFuture = false;
  db.state.eqCalls = [];
  db.state.isCalls = [];
  db.state.ltCalls = [];
  db.state.gtCalls = [];
  db.state.gteCalls = [];
  db.state.orderCalls = [];
  db.state.limitCalls = [];
  pace.withinBudget.mockReturnValue(true);
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

  it("prunes the future out-of-window backlog only for hydrated calendars, keyed per calendar (#1265)", async () => {
    db.state.eligible = [{ user_id: "u1", calendar_id: "cal-A" }];
    db.state.pages = [[], ["f1", "f2"]]; // past finds nothing; the future clause finds two rows then drains
    const res = await GET(req());
    const body = await res.json();
    expect(body.futurePruned).toBe(2);
    expect(body.futureCapped).toBe(false);
    // The gate read filters agent_calendars by sync_window_to in the future.
    expect(db.state.gtCalls).toContainEqual(["sync_window_to", expect.any(String)]);
    // The future block read is keyed per calendar and bounded to the future cutoff.
    expect(db.state.eqCalls).toContainEqual(["user_id", "u1"]);
    expect(db.state.eqCalls).toContainEqual(["calendar_id", "cal-A"]);
    expect(db.state.eqCalls).toContainEqual(["source", "gcal"]);
    expect(db.state.isCalls).toContainEqual(["booking_id", null]);
    const startsAtBound = db.state.gteCalls.find(([col]) => col === "starts_at");
    expect(startsAtBound).toBeDefined();
    // The future cutoff is far AHEAD (beyond the max horizon), the opposite end from the
    // past cutoff, so nothing a lead can book is ever in scope. Derived from HORIZON_MAX so
    // it still means "beyond the max horizon" if that is ever raised (L401).
    expect(Date.parse(startsAtBound![1]) - Date.now()).toBeGreaterThan(HORIZON_MAX * 24 * 60 * 60_000);
    expect(db.state.deletedBatches).toContainEqual(["f1", "f2"]);
  });

  it("leaves the future backlog alone when no calendar is hydrated past the gate (#1265)", async () => {
    db.state.eligible = [];
    db.state.pages = [["p1"]]; // a past row, so the past clause still runs
    const res = await GET(req());
    const body = await res.json();
    expect(body.futurePruned).toBe(0);
    // No future read happened at all: the gate held everything back.
    expect(db.state.gteCalls).toEqual([]);
  });

  it("fails loud when the eligible-calendars read errors, not a silent no-future-prune (#1265)", async () => {
    db.state.pages = [[]]; // past drains with nothing
    db.state.eligibleError = { message: "agent_calendars unreadable" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("agent_calendars") });
    // A failed future phase must not stamp the heartbeat as a healthy run.
    expect(hb.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("fails loud when the future candidate read errors (#1265)", async () => {
    db.state.eligible = [{ user_id: "u1", calendar_id: "cal-A" }];
    db.state.pages = [[]]; // past drains; the future read then errors
    db.state.futureReadError = { message: "starts_at column gone" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("starts_at") });
  });

  it("fails loud when the future delete errors, never scoring a null count as zero (#1265)", async () => {
    db.state.eligible = [{ user_id: "u1", calendar_id: "cal-A" }];
    db.state.pages = [[], ["f1"]]; // past empty; future selects one row then the delete errors
    db.state.deleteError = { message: "permission denied" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("permission denied") });
  });

  it("stops the future prune at the shared per-run cap and says capped (#1265)", async () => {
    db.state.eligible = [{ user_id: "u1", calendar_id: "cal-A" }];
    db.state.pages = [[]]; // past drains with nothing, leaving the whole cap for the future
    db.state.futureInexhaustible = true; // the future calendar's backlog never runs out
    const res = await GET(req());
    const body = await res.json();
    expect(body.futurePruned).toBe(BUSY_PRUNE_MAX_ROWS_PER_RUN);
    expect(body.futureCapped).toBe(true);
    expect(body.futureBudgetExhausted).toBe(false);
  });

  it("counts the past phase's rows against the shared cap, leaving less for the future (#1265)", async () => {
    // The past phase alone fills the whole shared cap; the future phase then gets zero and
    // is reported capped, proving the cap is shared and not doubled.
    db.state.eligible = [{ user_id: "u1", calendar_id: "cal-A" }];
    db.state.inexhaustible = true; // past backlog never runs out
    db.state.futureInexhaustible = true; // future would too, if any budget were left
    const res = await GET(req());
    const body = await res.json();
    expect(body.pruned).toBe(BUSY_PRUNE_MAX_ROWS_PER_RUN);
    expect(body.futurePruned).toBe(0);
    expect(body.futureCapped).toBe(true);
  });

  it("reports future budget exhaustion distinctly from a cap (#1265)", async () => {
    db.state.eligible = [{ user_id: "u1", calendar_id: "cal-A" }];
    pace.withinBudget.mockReturnValue(false); // the shared deadline is already spent
    const res = await GET(req());
    const body = await res.json();
    expect(body.futurePruned).toBe(0);
    expect(body.futureBudgetExhausted).toBe(true);
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

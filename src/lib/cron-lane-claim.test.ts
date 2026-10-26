import { describe, it, expect, vi, beforeEach } from "vitest";

// #4222: the route glue of a lane's claim on its tick. The rules are pinned in
// scripts/test-lane-claim.ts; this holds what a route gets back from the real client
// shape: the row inserted into lane_runs, a lost claim answered 200 duplicate, an
// unreadable claim or an unusable client answered 503 with nothing run, and a request
// with no tick id let through without a write.

const db = vi.hoisted(() => {
  const state = {
    result: { error: null } as { error: { code?: string; message: string } | null },
    rows: [] as Array<{ table: string; row: unknown }>,
    clientThrows: false,
  };
  const from = vi.fn((table: string) => ({
    insert: async (row: unknown) => {
      state.rows.push({ table, row });
      return state.result;
    },
  }));
  return { state, from };
});
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    if (db.state.clientThrows) throw new Error("SUPABASE_SECRET_KEY is not set");
    return { from: db.from };
  },
}));
vi.mock("@/lib/log", () => ({ log }));

import { claimLaneTick } from "./cron-lane-claim";
import { LANE_NOT_RUN_HEADER, TICK_ID_HEADER } from "@/lib/monitor/lane-failure";

const tick = (id: string) => new Headers({ [TICK_ID_HEADER]: id });

beforeEach(() => {
  vi.clearAllMocks();
  db.state.result = { error: null };
  db.state.rows = [];
  db.state.clientThrows = false;
});

describe("claimLaneTick (#4222)", () => {
  it("claims the tick for the lane and lets the lane run", async () => {
    const answer = await claimLaneTick(tick("abc123"), "/api/cron/prune-regal-calls");
    expect(answer).toBeNull();
    expect(db.state.rows).toEqual([{ table: "lane_runs", row: { tick_id: "abc123", lane: "prune_regal_calls" } }]);
  });

  it("answers a lost claim 200 duplicate, and the lane does not run", async () => {
    db.state.result = { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    const answer = await claimLaneTick(tick("abc123"), "/api/cron/sync");
    expect(answer?.status).toBe(200);
    expect(answer?.headers.get(LANE_NOT_RUN_HEADER)).toBe("duplicate");
    expect(await answer?.json()).toEqual({ skipped: "duplicate", lane: "sync", tick: "abc123" });
    expect(log.info).toHaveBeenCalledWith("cron", expect.objectContaining({ lane: "sync", tick: "abc123", not_run: "duplicate" }));
  });

  it("answers a claim that cannot be read 503, with the error logged", async () => {
    db.state.result = { error: { code: "42P01", message: 'relation "lane_runs" does not exist' } };
    const answer = await claimLaneTick(tick("abc123"), "/api/cron/sync");
    expect(answer?.status).toBe(503);
    expect(answer?.headers.get(LANE_NOT_RUN_HEADER)).toBe("claim_unreadable");
    expect(log.error).toHaveBeenCalledWith(
      "cron",
      expect.objectContaining({ lane: "sync", tick: "abc123", not_run: "claim_unreadable" }),
      expect.any(Error),
    );
  });

  it("answers 503 when the client itself cannot be made", async () => {
    db.state.clientThrows = true;
    const answer = await claimLaneTick(tick("abc123"), "/api/cron/sync");
    expect(answer?.status).toBe(503);
    expect(answer?.headers.get(LANE_NOT_RUN_HEADER)).toBe("claim_unreadable");
  });

  it("lets a request with no tick id run unclaimed, writing nothing", async () => {
    expect(await claimLaneTick(new Headers(), "/api/cron/sync")).toBeNull();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("refuses a tick id that is not one the dispatcher mints, writing nothing", async () => {
    const answer = await claimLaneTick(tick("not-a-tick"), "/api/cron/sync");
    expect(answer?.status).toBe(400);
    expect(answer?.headers.get(LANE_NOT_RUN_HEADER)).toBe("tick_unreadable");
    expect(db.from).not.toHaveBeenCalled();
  });
});

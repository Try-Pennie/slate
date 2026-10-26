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
const dispatch = vi.hoisted(() => ({ sendThrottledAlert: vi.fn(async () => {}), resolveAlert: vi.fn(async () => true) }));
vi.mock("@/lib/notify/dispatch", () => dispatch);

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    if (db.state.clientThrows) throw new Error("SUPABASE_SECRET_KEY is not set");
    return { from: db.from };
  },
}));
vi.mock("@/lib/log", () => ({ log }));

import { claimLaneTick } from "./cron-lane-claim";
import { LANE_NOT_RUN_HEADER, LANE_RESEND_HEADER, TICK_ID_HEADER } from "@/lib/monitor/lane-failure";

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

  it("runs a FIRST delivery whose claim cannot be read, and logs it on the lane's line (Dan, 2026-10-26)", async () => {
    db.state.result = { error: { code: "42P01", message: 'relation "lane_runs" does not exist' } };
    const answer = await claimLaneTick(tick("abc123"), "/api/cron/sync");
    expect(answer).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "cron",
      expect.objectContaining({ lane: "sync", tick: "abc123", claim: "unreadable" }),
      expect.any(Error),
    );
  });

  it("runs a first delivery when the client itself cannot be made", async () => {
    db.state.clientThrows = true;
    expect(await claimLaneTick(tick("abc123"), "/api/cron/sync")).toBeNull();
  });

  it("sends no alert from a lane: 28 lanes whose claims cannot be read in one minute post nothing themselves", async () => {
    db.state.result = { error: { code: "57014", message: "canceling statement due to statement timeout" } };
    const answers = await Promise.all(
      Array.from({ length: 28 }, (_, i) => claimLaneTick(tick("abc123"), `/api/cron/lane-${i}`)),
    );
    expect(answers.every((a) => a === null)).toBe(true);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(28);
  });

  it("refuses a RE-SEND whose claim cannot be read with 503, running nothing", async () => {
    db.state.result = { error: { code: "42P01", message: 'relation "lane_runs" does not exist' } };
    const answer = await claimLaneTick(
      new Headers({ [TICK_ID_HEADER]: "abc123", [LANE_RESEND_HEADER]: "1" }),
      "/api/cron/sync",
    );
    expect(answer?.status).toBe(503);
    expect(answer?.headers.get(LANE_NOT_RUN_HEADER)).toBe("claim_unreadable");
    expect(log.error).toHaveBeenCalledWith(
      "cron",
      expect.objectContaining({ lane: "sync", tick: "abc123", not_run: "claim_unreadable" }),
      expect.any(Error),
    );
  });

  it("still answers a re-send that lost its claim as a duplicate, not run", async () => {
    db.state.result = { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    const answer = await claimLaneTick(
      new Headers({ [TICK_ID_HEADER]: "abc123", [LANE_RESEND_HEADER]: "1" }),
      "/api/cron/sync",
    );
    expect(answer?.status).toBe(200);
    expect(answer?.headers.get(LANE_NOT_RUN_HEADER)).toBe("duplicate");
  });

  it("hands the claim to an observer, so the monitor lane can judge its own", async () => {
    const seen: unknown[] = [];
    db.state.result = { error: { code: "57014", message: "timeout" } };
    await claimLaneTick(tick("abc123"), "/api/cron/monitor", (c) => seen.push(c));
    expect(seen).toEqual([expect.objectContaining({ run: true, lane: "monitor", claim: "unreadable" })]);
    db.state.result = { error: null };
    await claimLaneTick(tick("abc124"), "/api/cron/monitor", (c) => seen.push(c));
    expect(seen[1]).toEqual(expect.objectContaining({ run: true, claim: "claimed" }));
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

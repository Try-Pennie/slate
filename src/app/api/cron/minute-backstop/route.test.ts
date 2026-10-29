import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-10-29: the five minute tick asks this route which every minute lanes have not
// claimed a tick in three minutes, and starts those (worker/lane-backstop.ts). The
// judgement is pinned offline in scripts/test-minute-lane-backstop.ts; this is the glue:
// auth first, the read's window, and above all the FAILURE path: a lane_runs read that
// fails names no lane (so nothing extra starts), answers 503, and pages, never an empty
// list that would read as "nothing overdue".
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
}));
const logged = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const db = vi.hoisted(() => ({
  rows: [] as { tick_id: string; lane: string; claimed_at: string }[],
  error: null as { message: string } | null,
  since: null as string | null,
  table: null as string | null,
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/log", () => logged);
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      db.table = table;
      return {
        select: () => ({
          gte: (_col: string, since: string) => {
            db.since = since;
            return {
              order: () => ({
                limit: async () => ({ data: db.error ? null : db.rows, error: db.error }),
              }),
            };
          },
        }),
      };
    },
  }),
}));

import { GET } from "./route";
import { MINUTE_BACKSTOP_UNREADABLE_KEY } from "@/lib/monitor/lane-copy";

const req = () =>
  new Request("https://slate.trypennie.app/api/cron/minute-backstop", {
    headers: { "x-slate-tick-id": "0f1e2d3c4b5a6978" },
  }) as unknown as Parameters<typeof GET>[0];

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  db.rows = [];
  db.error = null;
  db.since = null;
});

describe("GET /api/cron/minute-backstop", () => {
  it("returns 401 and reads nothing without the cron bearer", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(db.table).toBeNull();
  });

  it("names only the every minute lanes with no claim in three minutes", async () => {
    db.rows = [
      { tick_id: "a1", lane: "sync", claimed_at: iso(40_000) },
      { tick_id: "a1", lane: "recompute", claimed_at: iso(40_000) },
      { tick_id: "a0", lane: "outbox", claimed_at: iso(5 * 60_000) },
    ];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(db.table).toBe("lane_runs");
    expect(Date.now() - Date.parse(db.since!)).toBeGreaterThan(3 * 60_000);
    const body = (await res.json()) as { overdue: string[] };
    expect(body.overdue).toEqual(["/api/cron/outbox", "/api/cron/selfheal"]);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    // A measured read is the healthy result that ends an earlier unreadable page.
    expect(dispatch.resolveAlert).toHaveBeenCalledWith(MINUTE_BACKSTOP_UNREADABLE_KEY, expect.any(String));
  });

  it("names nothing when every lane claimed recently", async () => {
    db.rows = ["sync", "recompute", "outbox", "selfheal"].map((lane) => ({ tick_id: "a2", lane, claimed_at: iso(20_000) }));
    const body = (await (await GET(req())).json()) as { overdue: string[] };
    expect(body.overdue).toEqual([]);
  });

  it("a failed read names no lane, answers 503 and pages, never an empty healthy list", async () => {
    db.error = { message: "relation lane_runs is locked" };
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.overdue).toBeUndefined();
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text] = dispatch.sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe(MINUTE_BACKSTOP_UNREADABLE_KEY);
    expect(text).not.toContain("locked");
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    expect(logged.log.error).toHaveBeenCalled();
  });

  it("still answers 503 when the page itself cannot be sent", async () => {
    db.error = { message: "timeout" };
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    const res = await GET(req());
    expect(res.status).toBe(503);
  });

  it("a failed all clear does not turn a measured answer into a failure", async () => {
    dispatch.resolveAlert.mockRejectedValueOnce(new Error("slack down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

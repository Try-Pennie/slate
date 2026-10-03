import { describe, it, expect, vi, beforeEach } from "vitest";

// #3141: the recorder the Worker hands each notable tick to. What is pinned here is the
// write: a tick past half the CPU ceiling lands as its own lane_heartbeats row, the hourly
// tick stamps the verdict lane, a failed breach write fails the request rather than reading
// as recorded, and nothing unauthenticated or unreadable writes anything. The decision itself
// is pinned in scripts/test-cron-budget.ts.

const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const db = vi.hoisted(() => {
  const state = {
    upserts: [] as Array<Record<string, unknown>>,
    error: null as { message: string } | null,
  };
  const from = vi.fn((table: string) => ({
    upsert: async (row: Record<string, unknown>) => {
      state.upserts.push({ table, ...row });
      return { error: state.error };
    },
  }));
  return { state, from };
});
const verdicts = vi.hoisted(() => ({ recordDetectorVerdict: vi.fn(async () => {}) }));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: db.from }) }));
vi.mock("@/lib/monitor/verdict-store", () => verdicts);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";
import { CRON_BUDGET_WARN_MS } from "@/lib/monitor/cron-budget";

const req = (cronExpr: string, wallMs: number | string) =>
  ({
    url: `https://slate.trypennie.app/api/cron/cron-budget?cron=${encodeURIComponent(cronExpr)}&wall_ms=${wallMs}`,
  }) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  cron.isAuthorizedCron.mockReturnValue(true);
  db.state.upserts = [];
  db.state.error = null;
});

describe("GET /api/cron/cron-budget (#3141)", () => {
  it("records a tick past the line under its own cron expression", async () => {
    const res = await GET(req("* * * * *", CRON_BUDGET_WARN_MS + 500));
    expect(res.status).toBe(200);
    expect(db.state.upserts).toHaveLength(1);
    expect(db.state.upserts[0]).toMatchObject({ table: "lane_heartbeats", lane: "cron-over-budget:* * * * *" });
    expect(verdicts.recordDetectorVerdict).toHaveBeenCalledWith("verdict:cron-budget", false);
  });

  it("stamps the verdict on the hourly tick and writes no breach under the line", async () => {
    const res = await GET(req("0 * * * *", 4_000));
    expect(res.status).toBe(200);
    expect(db.state.upserts).toHaveLength(0);
    expect(verdicts.recordDetectorVerdict).toHaveBeenCalledWith("verdict:cron-budget", true);
  });

  it("fails the request when the breach write fails, so it is not read as recorded", async () => {
    db.state.error = { message: "relation does not exist" };
    const res = await GET(req("* * * * *", CRON_BUDGET_WARN_MS + 1));
    expect(res.status).toBe(500);
  });

  it("refuses an unreadable measurement and writes nothing", async () => {
    for (const bad of [req("* * * * *", "abc"), req("not a cron'; drop", 70_000), req("* * * * *", -1)]) {
      const res = await GET(bad);
      expect(res.status).toBe(400);
    }
    expect(db.state.upserts).toHaveLength(0);
    expect(verdicts.recordDetectorVerdict).not.toHaveBeenCalled();
  });

  it("refuses a caller without the cron secret", async () => {
    cron.isAuthorizedCron.mockReturnValue(false);
    const res = await GET(req("* * * * *", CRON_BUDGET_WARN_MS + 1));
    expect(res.status).toBe(401);
    expect(db.state.upserts).toHaveLength(0);
  });
});

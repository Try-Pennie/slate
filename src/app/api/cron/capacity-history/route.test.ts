import { describe, it, expect, vi, beforeEach } from "vitest";

// The capacity history lane (#3940). The rules and their refusals are driven natively by
// scripts/test-capacity-history.ts; what only this file can get wrong is the heartbeat: it may be
// stamped only once every organisation was recorded, or a lane failing every tick would look alive.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({ acquireLock: vi.fn(async (): Promise<string | null> => "token"), releaseLock: vi.fn(async () => {}) }));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));
const history = vi.hoisted(() => ({ runHistoryTick: vi.fn() }));
const orgs = vi.hoisted(() => ({ rows: [{ id: "org-1" }] as { id: string }[], error: null as { message: string } | null }));
vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
vi.mock("@/lib/admin/capacity-history", () => history);
vi.mock("@/lib/admin/capacity-history-store", () => ({ readHistoryCursor: vi.fn(), readSavedCalls: vi.fn(), writeHistory: vi.fn() }));
vi.mock("@/lib/admin/team-capacity-load", () => ({ loadCapacityRules: vi.fn(), loadCapacityPeople: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: async () => ({ data: orgs.rows, error: orgs.error }) }),
  }),
}));

import { GET } from "./route";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];
const ok = { days: ["2026-10-20"], rows: 3, open: 5, skippedMs: 0, nobodyBookable: false };

beforeEach(() => {
  vi.clearAllMocks();
  orgs.rows = [{ id: "org-1" }];
  orgs.error = null;
  cron.isAuthorizedCron.mockReturnValue(true);
  locks.acquireLock.mockResolvedValue("token");
});

describe("GET /api/cron/capacity-history", () => {
  it("records every organisation, then stamps the heartbeat", async () => {
    orgs.rows = [{ id: "org-1" }, { id: "org-2" }];
    history.runHistoryTick.mockResolvedValue(ok);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(history.runHistoryTick).toHaveBeenCalledTimes(2);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("capacity-history");
    expect(locks.releaseLock).toHaveBeenCalled();
  });

  it("fails without a heartbeat when a tick throws, so the watchdog pages", async () => {
    history.runHistoryTick.mockRejectedValueOnce(new Error("capacity history could not read calendars"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
    expect(locks.releaseLock).toHaveBeenCalled();
  });

  it("fails without a heartbeat when the organisations cannot be read, rather than recording nobody", async () => {
    orgs.error = { message: "refused" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(history.runHistoryTick).not.toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("fails when there is no organisation at all, since recording nothing would read as healthy", async () => {
    orgs.rows = [];
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("stands down for an overlapping run", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(history.runHistoryTick).not.toHaveBeenCalled();
  });

  it("refuses a caller without the cron secret", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(history.runHistoryTick).not.toHaveBeenCalled();
  });
});

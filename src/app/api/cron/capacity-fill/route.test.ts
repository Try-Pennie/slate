import { describe, it, expect, vi, beforeEach } from "vitest";

// The booking pace readings lane (#4102). The rules and their refusals are driven natively by
// scripts/test-capacity-fill.ts; what only this file can get wrong is the heartbeat: it may be
// stamped only once every organisation was recorded, or a lane failing every run would look alive.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({ acquireLock: vi.fn(async (): Promise<string | null> => "token"), releaseLock: vi.fn(async () => {}) }));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));
const fill = vi.hoisted(() => ({ runFillTick: vi.fn() }));
const store = vi.hoisted(() => ({ readFillLast: vi.fn(), writeFill: vi.fn(), readFillHistory: vi.fn(), readFillPattern: vi.fn() }));
const orgs = vi.hoisted(() => ({ rows: [{ id: "org-1" }] as { id: string }[], error: null as { message: string } | null }));
vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
vi.mock("@/lib/admin/capacity-fill", () => fill);
vi.mock("@/lib/admin/capacity-fill-store", () => store);
vi.mock("@/lib/admin/team-capacity-load", () => ({ loadCapacityRules: vi.fn(), loadCapacityPeople: vi.fn() }));
vi.mock("@/lib/booking/days-offered-load", () => ({ readOfferedOpenDays: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: async () => ({ data: orgs.rows, error: orgs.error }) }),
  }),
}));

import { GET } from "./route";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];
const ok = { readAtMs: 0, days: ["2026-10-20"], state: "recorded", wrote: true, rows: 1, measured: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  orgs.rows = [{ id: "org-1" }];
  orgs.error = null;
  cron.isAuthorizedCron.mockReturnValue(true);
  locks.acquireLock.mockResolvedValue("token");
});

describe("GET /api/cron/capacity-fill", () => {
  it("records every organisation, each through its own reads and write, then stamps the heartbeat", async () => {
    orgs.rows = [{ id: "org-1" }, { id: "org-2" }];
    fill.runFillTick.mockResolvedValue(ok);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(fill.runFillTick).toHaveBeenCalledTimes(2);
    // Every read and write is scoped to the org the run is for.
    for (const [i, org] of ["org-1", "org-2"].entries()) {
      const deps = fill.runFillTick.mock.calls[i]![0];
      await deps.readLast(["2026-10-20"]);
      await deps.write({ readAtMs: 0, prevReadAtMs: null, rows: [], last: [] });
      expect(store.readFillLast).toHaveBeenLastCalledWith(org, ["2026-10-20"]);
      expect(store.writeFill).toHaveBeenLastCalledWith(org, expect.anything());
      await deps.readHistory(["2026-10-20"], 5);
      await deps.readPattern(7);
      expect(store.readFillHistory).toHaveBeenLastCalledWith(org, ["2026-10-20"], 5);
      expect(store.readFillPattern).toHaveBeenLastCalledWith(org, 7);
    }
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("capacity-fill");
    expect(locks.releaseLock).toHaveBeenCalled();
  });

  it("fails without a heartbeat when a run throws, so the watchdog pages", async () => {
    orgs.rows = [{ id: "org-1" }, { id: "org-2" }];
    fill.runFillTick.mockResolvedValueOnce(ok).mockRejectedValueOnce(new Error("capacity fill could not read calendars"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
    expect(locks.releaseLock).toHaveBeenCalled();
  });

  it("fails without a heartbeat when the organisations cannot be read, rather than recording nobody", async () => {
    orgs.error = { message: "refused" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(fill.runFillTick).not.toHaveBeenCalled();
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
    expect(fill.runFillTick).not.toHaveBeenCalled();
  });

  it("refuses a caller without the cron secret", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(fill.runFillTick).not.toHaveBeenCalled();
  });
});

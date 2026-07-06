import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial guard for the watch cron (#676) + heartbeat wiring (#685). An
// unauthenticated caller must be rejected with 401 before any work; a
// successful tick stamps the 'watch' lane's dead-man's-switch heartbeat. The
// watch/renewal LOGIC is covered by the sync suite; this pins the route glue.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const sync = vi.hoisted(() => ({
  ensureWatches: vi.fn(async () => ({ status: "ok" })),
  loadSyncAgents: vi.fn(async () => []),
  loadFailingAgents: vi.fn(async () => []),
}));
const pace = vi.hoisted(() => ({
  orderAgentsForTick: vi.fn((a: unknown[]) => a),
  watchAgentsForTick: vi.fn(() => []),
  mapWithConcurrency: vi.fn(async () => ({ results: [], truncated: false })),
  SYNC_CONCURRENCY: 4,
}));
const dispatch = vi.hoisted(() => ({ sendThrottledAlert: vi.fn(async () => {}) }));
const alerts = vi.hoisted(() => ({ formatWatchLapseAlert: vi.fn(() => "") }));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/google/sync", () => sync);
vi.mock("@/lib/google/sync-pace", () => pace);
vi.mock("@/lib/google/sync-coalesce", () => ({ WATCH_LOCK_TTL_MS: 1000, SYNC_TICK_BUDGET_MS: 1000 }));
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/notify/alerts", () => alerts);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/watch", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  // Multi-lane dead-man's switch (#685): a successful tick stamps THIS lane.
  it("stamps the 'watch' heartbeat on a successful tick", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("watch");
  });

  it("still returns 200 when the heartbeat stamp fails (best-effort)", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    heartbeat.recordHeartbeat.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

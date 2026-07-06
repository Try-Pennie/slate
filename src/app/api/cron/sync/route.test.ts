import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial guard for the sync cron (#676) + heartbeat wiring (#685). An
// unauthenticated caller is rejected with 401 before any lock or calendar sync;
// a successful tick stamps the 'sync' lane's dead-man's-switch heartbeat. The
// sync LOGIC is covered by the booking-orchestration suite; this pins glue.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
// No failing agents = the quiet happy path: alertSyncFailures just clears the
// streak key via a delete().eq() chain.
const admin = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(() => ({
    from: () => ({ delete: () => ({ eq: async () => ({}) }) }),
  })),
}));
const sync = vi.hoisted(() => ({
  runIncrementalSync: vi.fn(async () => ({ events: 0, truncated: false })),
  loadSyncAgents: vi.fn(async () => []),
  markAgentsSynced: vi.fn(async () => {}),
  loadFailingAgents: vi.fn(async () => []),
}));
const pace = vi.hoisted(() => ({
  orderAgentsForTick: vi.fn((a: unknown[]) => a),
  mapWithConcurrency: vi.fn(async () => ({ results: [], processed: 0, truncated: false })),
  agentsWithChanges: vi.fn(() => []),
  SYNC_CONCURRENCY: 4,
  MAX_AGENTS_PER_SYNC_TICK: 200,
  MAX_TOUCHED_AGENTS: 50,
  MAX_TOUCHED_BUCKETS: 50,
}));
const precompute = vi.hoisted(() => ({ bucketsForAgent: vi.fn(async () => []) }));
const slotCache = vi.hoisted(() => ({ recomputeBucketSlotsForToday: vi.fn(async () => {}) }));
const dispatch = vi.hoisted(() => ({ sendThrottledAlert: vi.fn(async () => {}) }));
const alerts = vi.hoisted(() => ({
  formatSyncFailureAlert: vi.fn(() => ""),
  isConsecutiveFailure: vi.fn(() => false),
}));
// Fresh monitor heartbeat = no monitor-down alert on the happy path.
const heartbeat = vi.hoisted(() => ({
  isHeartbeatStale: vi.fn(() => false),
  readHeartbeatMs: vi.fn(async () => 1),
  recordHeartbeat: vi.fn(async () => {}),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/google/sync", () => sync);
vi.mock("@/lib/google/sync-pace", () => pace);
vi.mock("@/lib/availability/precompute", () => precompute);
vi.mock("@/lib/availability/slot-cache", () => slotCache);
vi.mock("@/lib/google/sync-coalesce", () => ({ CRON_LOCK_TTL_MS: 1000, SYNC_TICK_BUDGET_MS: 1000 }));
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/notify/alerts", () => alerts);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/sync", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  // Multi-lane dead-man's switch (#685): a successful tick stamps THIS lane.
  it("stamps the 'sync' heartbeat on a successful tick", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("sync");
  });

  it("still returns 200 when the heartbeat stamp fails (best-effort)", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    heartbeat.recordHeartbeat.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

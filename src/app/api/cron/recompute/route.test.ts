import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial guard for the recompute cron (#676) + heartbeat wiring (#685). An
// unauthenticated caller is rejected with 401 before any lock or bucket work; a
// successful tick stamps the 'recompute' lane's dead-man's-switch heartbeat.
// The recompute LOGIC lives in the precompute-cron unit tests; this pins glue.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
// Drained headroom + no due/stale buckets = the quiet happy path (no alerts).
const admin = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(() => ({
    from: () => ({ delete: () => ({ eq: async () => ({}) }) }),
  })),
}));
const pace = vi.hoisted(() => ({ withinBudget: vi.fn(() => true) }));
const precompute = vi.hoisted(() => ({
  listAllBucketCodes: vi.fn(async () => []),
  listKnownBucketSlotRows: vi.fn(async () => []),
}));
const precomputeCron = vi.hoisted(() => ({
  bucketsDueForRecompute: vi.fn(() => []),
  staleBuckets: vi.fn(() => []),
  recomputeHeadroom: vi.fn(() => ({ drained: true, utilizationPct: 0 })),
  recomputeDueBuckets: vi.fn(async () => 0),
}));
const slotCache = vi.hoisted(() => ({ recomputeBucketSlotsForToday: vi.fn(async () => {}) }));
const dispatch = vi.hoisted(() => ({ sendThrottledAlert: vi.fn(async () => {}) }));
const alerts = vi.hoisted(() => ({ isConsecutiveFailure: vi.fn(() => false) }));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/google/sync-pace", () => pace);
vi.mock("@/lib/google/sync-coalesce", () => ({ RECOMPUTE_LOCK_TTL_MS: 1000 }));
vi.mock("@/lib/availability/precompute", () => precompute);
vi.mock("@/lib/availability/precompute-cron", () => precomputeCron);
vi.mock("@/lib/availability/slot-cache", () => slotCache);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/notify/alerts", () => alerts);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/recompute", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  // Multi-lane dead-man's switch (#685): a successful tick stamps THIS lane.
  it("stamps the 'recompute' heartbeat on a successful tick", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("recompute");
  });

  it("still returns 200 when the heartbeat stamp fails (best-effort)", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    heartbeat.recordHeartbeat.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

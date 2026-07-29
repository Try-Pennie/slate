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
    // The behind-streak tracker on the NOT-drained path (#1151 tests drive it).
    rpc: async () => ({ data: true, error: null }),
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
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  resolveRecovered: vi.fn(async (_r: { key: string; text: string }[]) => [] as string[]),
}));
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

  // #1151: both of this lane's alerts describe CONDITIONS, so a healthy cycle
  // says they are over. Which conditions get cleared is driven by what the cycle
  // MEASURED, never by "we did not alert this tick".
  it("clears both conditions on a cycle that drained its work with nothing stale", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    await GET(req());
    const keys = (dispatch.resolveRecovered.mock.calls[0]?.[0] ?? []).map((r) => r.key);
    expect(keys.sort()).toEqual(["bucket_slots_stale", "recompute_headroom"]);
  });

  it("clears only the stale condition when the cycle did NOT drain its due list", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    precomputeCron.recomputeHeadroom.mockReturnValueOnce({ drained: false, utilizationPct: 99 });
    await GET(req());
    const keys = (dispatch.resolveRecovered.mock.calls[0]?.[0] ?? []).map((r) => r.key);
    expect(keys).toEqual(["bucket_slots_stale"]);
  });

  // The silent path (#1152): rows still stale means the condition is NOT over, so
  // that key must not be cleared even though the other one can be.
  it("clears only the headroom condition while rows are still stale", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    precomputeCron.staleBuckets.mockReturnValueOnce(["411", "412"] as never);
    await GET(req());
    const keys = (dispatch.resolveRecovered.mock.calls[0]?.[0] ?? []).map((r) => r.key);
    expect(keys).toEqual(["recompute_headroom"]);
  });

  // The silent path (#1152): a cycle that is BOTH behind and still stale has
  // measured nothing healthy, so it must announce nothing.
  it("sends NO all-clear when the cycle is behind and rows are still stale", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    precomputeCron.recomputeHeadroom.mockReturnValueOnce({ drained: false, utilizationPct: 99 });
    precomputeCron.staleBuckets.mockReturnValueOnce(["411"] as never);
    await GET(req());
    expect(dispatch.resolveRecovered).not.toHaveBeenCalled();
  });

  it("still returns 200 when the heartbeat stamp fails (best-effort)", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    heartbeat.recordHeartbeat.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

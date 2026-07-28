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
const precompute = vi.hoisted(() => ({
  // #762: the lane now resolves every changed agent's buckets in one batched call.
  touchedBucketCodes: vi.fn(async () => [] as string[]),
}));
const slotCache = vi.hoisted(() => ({ recomputeBucketSlotsForToday: vi.fn(async () => {}) }));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  resolveAlert: vi.fn(async () => false),
  // Default true so the clean-tick tests exercise the recovery path; a dedicated
  // test below flips it to prove the health work is skipped when nothing is firing.
  isAlertFiring: vi.fn(async () => true),
}));
const alerts = vi.hoisted(() => ({
  formatSyncFailureAlert: vi.fn(() => ""),
  isConsecutiveFailure: vi.fn(() => false),
  formatSyncRecoveryNotice: vi.fn(() => "recovered"),
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

beforeEach(() => {
  vi.clearAllMocks();
  dispatch.isAlertFiring.mockResolvedValue(true);
  sync.loadFailingAgents.mockResolvedValue([]);
});

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

  // #1133: a cleared page must SAY it cleared. Silence is indistinguishable from
  // the 30-minute cooldown still running, so a clean tick offers the recovery
  // notice (resolveAlert is a no-op unless a page was actually delivered).
  it("offers the recovery notice on a clean tick", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    await GET(req());
    expect(dispatch.resolveAlert).toHaveBeenCalledWith("sync_failures", "recovered");
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // #1134: a clean tick only proves the agents this tick REACHED are healthy (it is
  // capped and budgeted), so health is confirmed against the stored streaks before
  // any all-clear, and an unreadable signal stays silent.
  it("does not all-clear on a clean tick when the stored streaks say agents are still failing", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    sync.loadFailingAgents.mockResolvedValue([
      { email: "a@x.com", consecutiveFailures: 12, lastSuccessAt: null, error: "503" },
    ] as never);
    await GET(req());
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("does not all-clear on a clean tick when the health signal cannot be read", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    sync.loadFailingAgents.mockResolvedValue(null as never);
    await GET(req());
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("skips the health confirmation entirely when no page is outstanding", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    dispatch.isAlertFiring.mockResolvedValue(false);
    await GET(req());
    // The overwhelmingly common case: nothing to clear, so it must not pay for the
    // extra reads that proving health costs.
    expect(sync.loadFailingAgents).not.toHaveBeenCalled();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("does not offer a recovery notice while agents are still failing", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    pace.mapWithConcurrency.mockResolvedValueOnce({
      results: [{ userId: "u1", error: "503" }],
      processed: 1,
      truncated: false,
    } as never);
    alerts.isConsecutiveFailure.mockReturnValueOnce(true);
    sync.loadFailingAgents.mockResolvedValueOnce([
      { email: "a@x.com", consecutiveFailures: 12, lastSuccessAt: null, error: "503" },
    ] as never);
    // rate_limit_hit lives on the same mocked client; the streak read must answer.
    admin.supabaseAdmin.mockReturnValueOnce({
      from: () => ({ delete: () => ({ eq: async () => ({}) }) }),
      rpc: async () => ({ data: false, error: null }),
    } as never);

    await GET(req());
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  // #1134: the recovery notice must never be sent on the strength of a FAILED read.
  // loadFailingAgents returns null for "could not determine", which used to be an
  // empty list and so was indistinguishable from "nothing is failing" (a false
  // all-clear the moment #1133 made empty mean recovered).
  it("does not offer a recovery notice when the health read could not be completed", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    pace.mapWithConcurrency.mockResolvedValueOnce({
      results: [{ userId: "u1", error: "503" }],
      processed: 1,
      truncated: false,
    } as never);
    alerts.isConsecutiveFailure.mockReturnValueOnce(true);
    sync.loadFailingAgents.mockResolvedValueOnce(null as never);
    admin.supabaseAdmin.mockReturnValueOnce({
      from: () => ({ delete: () => ({ eq: async () => ({}) }) }),
      rpc: async () => ({ data: false, error: null }),
    } as never);

    await GET(req());
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // Failure path: a monitoring failure must never become a sync failure.
  it("still returns 200 when the recovery notice throws", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    dispatch.resolveAlert.mockRejectedValueOnce(new Error("slack down") as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

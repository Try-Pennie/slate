import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial guard for the watch cron (#676) + heartbeat wiring (#685). An
// unauthenticated caller must be rejected with 401 before any work; a
// successful tick stamps the 'watch' lane's dead-man's-switch heartbeat. The
// watch/renewal LOGIC is covered by the sync suite; this pins the route glue.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const locks = vi.hoisted(() => ({
  acquireLease: vi.fn(async () => ({ key: "cron_watch", token: () => "lease", stillHeld: async () => true })),
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
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  resolveAlert: vi.fn(async (_key: string, _text: string) => false),
  // Default true so the healthy-tick tests reach the recovery path; one test below
  // flips it to prove a healthy tick with nothing outstanding does no extra work.
  isAlertFiring: vi.fn(async (_key: string) => true),
}));
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
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  sync.loadFailingAgents.mockResolvedValue([]);
  dispatch.isAlertFiring.mockResolvedValue(true);
});

// #3120: two overlapping ticks renewing one calendar each open a Google channel, so
// a tick whose lease is gone must not start another agent.
describe("the watch lane lease (#3120)", () => {
  const runTasks = async (agents: unknown[], _c: number, task: (a: unknown) => Promise<unknown>) => {
    const results = [];
    for (const a of agents) results.push(await task(a));
    return { results, truncated: false };
  };
  const twoAgents = [
    { userId: "u1", hasCalendars: true },
    { userId: "u2", hasCalendars: true },
  ];

  it("starts no agent once the lease is lost", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    pace.watchAgentsForTick.mockReturnValueOnce(twoAgents as never);
    pace.mapWithConcurrency.mockImplementationOnce(runTasks as never);
    locks.acquireLease.mockResolvedValueOnce({ key: "cron_watch", token: () => "lease", stillHeld: async () => false });
    await GET(req());
    expect(sync.ensureWatches).not.toHaveBeenCalled();
  });

  it("CONTROL: a held lease renews every agent", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    pace.watchAgentsForTick.mockReturnValueOnce(twoAgents as never);
    pace.mapWithConcurrency.mockImplementationOnce(runTasks as never);
    await GET(req());
    expect(sync.ensureWatches).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/cron/watch", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLease).not.toHaveBeenCalled();
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
  // #1134: the watch-lapse page must say when it clears, and must NEVER all-clear on
  // the strength of a read it could not complete. loadFailingAgents returns null for
  // "could not determine", which used to be an empty list and so was indistinguishable
  // from "every calendar is watched and renewing".
  it("says so when the watch-lapse condition clears", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    await GET(req());
    expect(dispatch.resolveAlert).toHaveBeenCalledWith("watch_lapse", expect.any(String));
    const [, text] = dispatch.resolveAlert.mock.calls[0];
    expect(text).toMatch(/recover|cleared/i);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("does NOT all-clear when the health signal cannot be read", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    sync.loadFailingAgents.mockResolvedValue(null as never);
    await GET(req());
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("alerts and does not all-clear while calendars are still failing to renew", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    sync.loadFailingAgents.mockResolvedValue([
      { email: "a@x.com", consecutiveFailures: 12, lastSuccessAt: null, error: "503" },
    ] as never);
    await GET(req());
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(dispatch.sendThrottledAlert.mock.calls[0][0]).toBe("watch_lapse");
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });
  it("does no extra work on a healthy tick with no page outstanding", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    dispatch.isAlertFiring.mockResolvedValue(false);
    await GET(req());
    expect(sync.loadFailingAgents).not.toHaveBeenCalled();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring for the agents (roster) cron (#486/#487): a single failing pass must
// stay quiet (transient SF blips self-heal next hour); only CONSECUTIVE failures
// alert, and a clean pass clears the streak. The streak/alert decision logic is
// covered elsewhere (isConsecutiveFailure); this exercises only the route glue.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const sync = vi.hoisted(() => ({
  syncSalesforceAgents: vi.fn(),
  AGENTS_SYNC_STREAK_KEY: "cron_agents_failures",
}));
const provision = vi.hoisted(() => ({
  ensureDefaultOrg: vi.fn(async () => ({ id: "org1" })),
}));
const schedule = vi.hoisted(() => ({ ensureDefaultSchedules: vi.fn(async () => 0) }));
const availability = vi.hoisted(() => ({
  alertOnEmptyBuckets: vi.fn(async () => ({ empty: [], aggregated: false })),
}));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(
    async (_key: string, _cooldownMs: number, _text: string) => {},
  ),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
}));
const streak = vi.hoisted(() => ({
  recordFailureStreak: vi.fn(),
  clearFailureStreak: vi.fn(async () => {}),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/salesforce/sync", () => sync);
vi.mock("@/lib/provision", () => provision);
vi.mock("@/lib/schedule", () => schedule);
vi.mock("@/lib/availability/service", () => availability);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/notify/streak", () => streak);

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  sync.syncSalesforceAgents.mockResolvedValue({
    inserted: 0,
    updated: 0,
    deactivated: 0,
    managersCreated: 0,
    managersLinked: 0,
    managersPromoted: 0,
  });
  streak.recordFailureStreak.mockResolvedValue(false);
});

describe("GET /api/cron/agents", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(sync.syncSalesforceAgents).not.toHaveBeenCalled();
  });

  it("clears the failure streak and does not alert on a clean pass", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(streak.clearFailureStreak).toHaveBeenCalledTimes(1);
    expect(streak.recordFailureStreak).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // #1151: a failing roster sync is a CONDITION, so a clean pass says it is over.
  it("announces recovery on a clean pass, so the earlier page can be closed", async () => {
    await GET(req());
    expect(dispatch.resolveAlert).toHaveBeenCalledTimes(1);
    expect(dispatch.resolveAlert.mock.calls[0][0]).toBe("agent_sync_failures");
  });

  // The silent path (#1152): the sync FAILING is not evidence that it works, so a
  // run that could not read its health signal must announce nothing.
  it("sends NO all-clear when the sync itself failed", async () => {
    sync.syncSalesforceAgents.mockRejectedValueOnce(new Error("SF unreachable"));
    await GET(req());
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("stays quiet on a single (self-healing) failure", async () => {
    sync.syncSalesforceAgents.mockRejectedValueOnce(
      new Error("SF token failed: 522 error code: 522"),
    );
    streak.recordFailureStreak.mockResolvedValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(streak.recordFailureStreak).toHaveBeenCalledTimes(1);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("alerts once the failures are consecutive, calling the schedule hourly", async () => {
    sync.syncSalesforceAgents.mockRejectedValueOnce(
      new Error("SF token failed: 522 error code: 522"),
    );
    streak.recordFailureStreak.mockResolvedValueOnce(true);
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [, , text] = dispatch.sendThrottledAlert.mock.calls[0];
    expect(text).toContain("hourly");
    expect(text).not.toContain("daily");
    expect(text).toContain("522");
  });
});

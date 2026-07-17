import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial guard for the complete cron (#676): an unauthenticated caller (missing
// or wrong Bearer) must be rejected with 401 BEFORE any work (no lock, no DB).
// The happy-path completion logic is covered by the booking-orchestration suite;
// this pins only the auth short-circuit.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const service = vi.hoisted(() => ({
  completePastBookings: vi.fn(async () => ({ completed: 0, backlogRemains: false })),
}));
const emit = vi.hoisted(() => ({ retryFailedDeliveries: vi.fn(async () => 0) }));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));
const saturation = vi.hoisted(() => ({ reportCompletionSaturation: vi.fn(async () => {}) }));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/webhooks/emit", () => emit);
vi.mock("@/lib/google/sync-coalesce", () => ({ CRON_LOCK_TTL_MS: 1000 }));
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
vi.mock("@/lib/monitor/sweep-saturation", () => saturation);

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/complete", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(service.completePastBookings).not.toHaveBeenCalled();
    expect(emit.retryFailedDeliveries).not.toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  // Multi-lane dead-man's switch (#685): a successful tick stamps THIS lane.
  it("stamps the 'complete' heartbeat on a successful tick", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("complete");
  });

  it("still returns 200 when the heartbeat stamp fails (best-effort)", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    heartbeat.recordHeartbeat.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });

  // #883: the sweep's over-budget verdict is handed to the saturation reporter so
  // a sustained backlog pages instead of only logging.
  it("reports the completion sweep's backlog verdict for the saturation streak", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    service.completePastBookings.mockResolvedValueOnce({ completed: 5000, backlogRemains: true });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(saturation.reportCompletionSaturation).toHaveBeenCalledWith(
      "completion_sweep_saturated",
      true,
    );
  });

  // Monitoring must never take down the lane it watches.
  it("still returns 200 when the saturation report throws", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    saturation.reportCompletionSaturation.mockRejectedValueOnce(new Error("slack down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

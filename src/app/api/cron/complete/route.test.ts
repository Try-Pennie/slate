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
const sweepFailure = vi.hoisted(() => ({
  reportSweepFailures: vi.fn(async (_outcomes: { key: string; ok: boolean }[]) => {}),
  COMPLETION_SWEEP_FAILING_KEY: "completion_sweep_failing",
  WEBHOOK_RETRY_SWEEP_FAILING_KEY: "webhook_retry_sweep_failing",
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/webhooks/emit", () => emit);
vi.mock("@/lib/google/sync-coalesce", () => ({ CRON_LOCK_TTL_MS: 1000 }));
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
vi.mock("@/lib/monitor/sweep-saturation", () => saturation);
vi.mock("@/lib/monitor/sweep-failure", () => sweepFailure);

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

  // #887: the two jobs are isolated. A completion-sweep failure must not stop the
  // delivery retry or the heartbeat, and must not 500 the lane.
  it("still retries deliveries and stamps the heartbeat when the completion sweep throws", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    service.completePastBookings.mockRejectedValueOnce(new Error("completion boom"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(emit.retryFailedDeliveries).toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("complete");
  });

  // #887: a failed completion sweep tells the saturation streak NOTHING (null),
  // never a fabricated `false` that would wrongly clear a real backlog streak.
  it("reports a null backlog verdict when the completion sweep throws", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    service.completePastBookings.mockRejectedValueOnce(new Error("completion boom"));
    await GET(req());
    expect(saturation.reportCompletionSaturation).toHaveBeenCalledWith(
      "completion_sweep_saturated",
      null,
    );
  });

  // #887: the other direction. A delivery-retry failure must not stop the
  // heartbeat or 500 the lane.
  it("still stamps the heartbeat when the delivery retry throws", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    emit.retryFailedDeliveries.mockRejectedValueOnce(new Error("retry boom"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("complete");
  });

  // #2544. The saturation streak above is deliberately told NOTHING by a failed
  // run, and until now nothing else spoke for that outcome either: the catch
  // logged, the body said `completed: "error"` on a 200, and the heartbeat was
  // stamped either way, so a sweep failing every five minutes paged nobody.
  it("reports both sweeps as healthy on an ordinary tick", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    await GET(req());
    expect(sweepFailure.reportSweepFailures).toHaveBeenCalledWith([
      { key: "completion_sweep_failing", ok: true },
      { key: "webhook_retry_sweep_failing", ok: true },
    ]);
  });

  it("reports the completion sweep as failing when it throws", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    service.completePastBookings.mockRejectedValueOnce(new Error("completion boom"));
    const res = await GET(req());
    // The lane stays alive and honest: a 200, an "error" in the body, AND a signal
    // somebody will actually receive.
    expect(res.status).toBe(200);
    expect((await res.json()).completed).toBe("error");
    expect(sweepFailure.reportSweepFailures).toHaveBeenCalledWith([
      { key: "completion_sweep_failing", ok: false },
      { key: "webhook_retry_sweep_failing", ok: true },
    ]);
  });

  it("reports the delivery retry as failing on its own, without accusing the other sweep", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    emit.retryFailedDeliveries.mockRejectedValueOnce(new Error("retry boom"));
    await GET(req());
    expect(sweepFailure.reportSweepFailures).toHaveBeenCalledWith([
      { key: "completion_sweep_failing", ok: true },
      { key: "webhook_retry_sweep_failing", ok: false },
    ]);
  });

  // Monitoring must never take down the lane it watches (L71).
  it("still returns 200 when the sweep failure report throws", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    sweepFailure.reportSweepFailures.mockRejectedValueOnce(new Error("slack down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

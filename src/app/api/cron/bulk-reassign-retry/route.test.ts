import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial + lane-shape guard for the hourly coverage-retry cron (#3485). An unauthenticated
// caller is rejected with 401 before the lock or any work; two overlapping ticks never both
// run; and a failed retry keeps the lane alive (200 with an error body, logged) rather than
// throwing, because the retry is an optimisation and the stranded page is the safety net.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const locks = vi.hoisted(() => ({
  acquireLease: vi.fn(async () => ({ token: () => "lease", stillHeld: async () => true })),
  releaseLock: vi.fn(async () => {}),
}));
const service = vi.hoisted(() => ({
  retryUnplaceableCoverageJobs: vi.fn(async () => ({ reArmed: 0, considered: 0 })),
}));
const sweepFailure = vi.hoisted(() => ({
  reportSweepFailures: vi.fn(async (_outcomes: { key: string; ok: boolean }[]) => {}),
  COVERAGE_RETRY_SWEEP_FAILING_KEY: "coverage_retry_sweep_failing",
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/monitor/sweep-failure", () => sweepFailure);
vi.mock("@/lib/google/sync-coalesce", () => ({ CRON_LOCK_TTL_MS: 1000 }));

import { GET } from "./route";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/bulk-reassign-retry", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLease).not.toHaveBeenCalled();
    expect(service.retryUnplaceableCoverageJobs).not.toHaveBeenCalled();
  });

  it("skips without working when another tick holds the lock", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    locks.acquireLease.mockResolvedValueOnce(null as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe("overlapping-run");
    expect(service.retryUnplaceableCoverageJobs).not.toHaveBeenCalled();
  });

  it("re-arms on an ordinary tick, reports the sweep healthy, and returns the summary", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    service.retryUnplaceableCoverageJobs.mockResolvedValueOnce({ reArmed: 3, considered: 5 });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reArmed: 3, considered: 5 });
    expect(sweepFailure.reportSweepFailures).toHaveBeenCalledWith([
      { key: "coverage_retry_sweep_failing", ok: true },
    ]);
    expect(locks.releaseLock).toHaveBeenCalled();
  });

  it("stays alive on a failed retry (200 + error body), reports the sweep failing, releases the lock", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    service.retryUnplaceableCoverageJobs.mockRejectedValueOnce(new Error("schema fault"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).error).toBe("retry-failed");
    expect(sweepFailure.reportSweepFailures).toHaveBeenCalledWith([
      { key: "coverage_retry_sweep_failing", ok: false },
    ]);
    expect(locks.releaseLock).toHaveBeenCalled();
  });

  it("stays alive when the sweep-failure report itself throws (L71)", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    sweepFailure.reportSweepFailures.mockRejectedValueOnce(new Error("slack down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

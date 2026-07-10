import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial guard for the self-heal cron (#676): an unauthenticated caller must be
// rejected with 401 before any lock or booking-safety sweep runs. The sweep
// logic itself is covered by the booking-orchestration suite.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const service = vi.hoisted(() => ({
  processPendingEventDeletions: vi.fn(async () => ({})),
  reconcileCancelledBusyBlocks: vi.fn(async () => ({ freed: 0, scanned: 0 })),
  reconcileMissingBusyBlocks: vi.fn(async () => ({ recreated: 0, scanned: 0 })),
}));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));
// The rotating-scan cursor (#512) has its own suite; here it just runs the sweep
// at offset 0 so this denial/heartbeat guard doesn't need a DB.
const cursor = vi.hoisted(() => ({
  rotateSelfhealScan: vi.fn(async (_key: string, _limit: number, run: (o: number) => Promise<unknown>) =>
    run(0),
  ),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/booking/selfheal-cursor", () => cursor);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/selfheal", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(service.processPendingEventDeletions).not.toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  // Multi-lane dead-man's switch (#685): a successful tick stamps THIS lane,
  // even though the sub-sweeps swallow their own errors into "error" markers.
  it("stamps the 'selfheal' heartbeat on a successful tick", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("selfheal");
  });

  it("still returns 200 when the heartbeat stamp fails (best-effort)", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    heartbeat.recordHeartbeat.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

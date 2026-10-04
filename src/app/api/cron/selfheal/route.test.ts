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
  checkCreationOrphans: vi.fn(async () => ({ scanned: 0, confirmed: [] as { id: string }[] })),
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
// #239/#248 pool-exit reconcile backstop. Its own logic is covered by the
// pool-exit suite; here it's mocked so the lane wiring can be asserted.
const google = vi.hoisted(() => ({
  reconcileOrphanedPoolExits: vi.fn(async () => ({ scanned: 3, cleaned: 2, blocksDeleted: 40 })),
}));
// #1152: the saturation reporters decide whether an all-clear goes out, so what
// this lane hands them on a FAILED sweep is the thing under test here.
const saturation = vi.hoisted(() => ({
  reportSweepSaturation: vi.fn(
    async (_sweep: string, _key: string, _drained: number | null, _limit: number) => {},
  ),
  reportDeletionSaturation: vi.fn(
    async (_key: string, _drain: { deleted: number; failed: number } | null, _limit: number) => {},
  ),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/booking/selfheal-cursor", () => cursor);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
vi.mock("@/lib/google/sync", () => google);
vi.mock("@/lib/monitor/sweep-saturation", () => saturation);
// #3248: the reroute hold expiry sweep. Its logic has its own suite
// (scripts/test-reroute-hold-store.ts); here it is mocked so the lane wiring and
// its own heartbeat can be asserted.
const holds = vi.hoisted(() => ({
  sweepExpiredRerouteHoldBlocks: vi.fn(async () => ({ freed: 2 })),
}));
const holdDeps = vi.hoisted(() => ({ rerouteHoldStoreDeps: vi.fn(() => ({})) }));
vi.mock("@/lib/booking/reroute-hold-store", () => holds);
vi.mock("@/lib/booking/reroute-hold-store-live", () => holdDeps);

import { GET } from "./route";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];

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

  // #239/#248: the pool-exit reconcile runs on this lane and its counts surface
  // in the response so the sweep is observable.
  it("runs the pool-exit reconcile backstop and surfaces its counts", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    const res = await GET(req());
    expect(google.reconcileOrphanedPoolExits).toHaveBeenCalledWith(25);
    const body = await res.json();
    expect(body.poolExitCleaned).toBe(2);
    expect(body.poolExitBlocksDeleted).toBe(40);
  });

  // Failure path: a throwing reconcile is caught, the tick still stamps its
  // heartbeat and returns 200, and the counts read "error".
  it("still returns 200 and stamps the heartbeat when the pool-exit reconcile throws", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    google.reconcileOrphanedPoolExits.mockRejectedValueOnce(new Error("google down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.poolExitCleaned).toBe("error");
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("selfheal");
  });

  // #3248: the expiry sweep for reroute hold blocks runs here every minute, with a
  // heartbeat of its OWN, stamped only when the sweep itself succeeded (L13): the
  // lane's heartbeat proves only that the lane ran.
  it("runs the reroute hold expiry sweep and stamps its own heartbeat", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    const res = await GET(req());
    expect(holds.sweepExpiredRerouteHoldBlocks).toHaveBeenCalledTimes(1);
    expect((await res.json()).rerouteHoldBlocksFreed).toBe(2);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("reroute-hold-sweep");
  });

  it("does not stamp the sweep's heartbeat when the sweep throws, and the lane still runs", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    holds.sweepExpiredRerouteHoldBlocks.mockRejectedValueOnce(new Error("timeout"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).rerouteHoldBlocksFreed).toBe("error");
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalledWith("reroute-hold-sweep");
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("selfheal");
  });

  it("contains a throw while wiring the sweep's deps to the sweep alone (L73)", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    holdDeps.rerouteHoldStoreDeps.mockImplementationOnce(() => {
      throw new Error("SUPABASE_SECRET_KEY is not set");
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).rerouteHoldBlocksFreed).toBe("error");
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("selfheal");
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalledWith("reroute-hold-sweep");
  });

  // #830: the creation-orphan check runs on this lane and its confirmed count
  // surfaces in the response.
  it("runs the creation-orphan check and surfaces its confirmed count", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    service.checkCreationOrphans.mockResolvedValueOnce({ scanned: 3, confirmed: [{ id: "a" }, { id: "b" }] });
    const res = await GET(req());
    expect(service.checkCreationOrphans).toHaveBeenCalledWith(20);
    const body = await res.json();
    expect(body.creationOrphans).toBe(2);
  });

  // Failure path: a throwing creation-orphan check is caught; the tick still
  // returns 200 and the count reads "error".
  it("still returns 200 when the creation-orphan check throws", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    service.checkCreationOrphans.mockRejectedValueOnce(new Error("google down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creationOrphans).toBe("error");
  });

  // #1152: a sweep that FAILED knows nothing about its backlog, so the lane must
  // hand the saturation reporter `null` ("could not tell") rather than the zero a
  // swallowed read error used to produce. Zero is the healthy verdict: it clears
  // the failure streak and posts an all-clear saying the backlog has drained and
  // no action is needed. The reporters already treat `null` correctly (their own
  // suite pins that); what these pin is that the failure reaches them AS null.
  describe("a failed sweep reports an unknown verdict, never a healthy zero (#1152)", () => {
    const sweepVerdict = (sweep: string) =>
      saturation.reportSweepSaturation.mock.calls.find((c) => c[0] === sweep)?.[2];
    const deletionVerdict = () => saturation.reportDeletionSaturation.mock.calls[0]?.[1];

    it("hands the cancelled-block reconcile's saturation reporter null when the sweep throws", async () => {
      cron.isAuthorizedCron.mockReturnValueOnce(true);
      service.reconcileCancelledBusyBlocks.mockRejectedValueOnce(new Error("read failed"));

      await GET(req());

      expect(sweepVerdict("cancelled-block reconcile")).toBeNull();
    });

    it("hands the missing-block reconcile's saturation reporter null when the sweep throws", async () => {
      cron.isAuthorizedCron.mockReturnValueOnce(true);
      service.reconcileMissingBusyBlocks.mockRejectedValueOnce(new Error("read failed"));

      await GET(req());

      expect(sweepVerdict("missing-block reconcile")).toBeNull();
    });

    it("hands the deletion drain's saturation reporter null when the drain throws", async () => {
      cron.isAuthorizedCron.mockReturnValueOnce(true);
      service.processPendingEventDeletions.mockRejectedValueOnce(new Error("read failed"));

      await GET(req());

      expect(deletionVerdict()).toBeNull();
    });

    // Control: the healthy path really does report a verdict, so the three tests
    // above can't be passing because nothing is ever reported.
    it("reports each sweep's real verdict when the sweeps succeed", async () => {
      cron.isAuthorizedCron.mockReturnValueOnce(true);
      service.reconcileCancelledBusyBlocks.mockResolvedValueOnce({ freed: 4, scanned: 4 });
      service.reconcileMissingBusyBlocks.mockResolvedValueOnce({ recreated: 2, scanned: 2 });
      service.processPendingEventDeletions.mockResolvedValueOnce({ deleted: 3, failed: 1, held: 0 });

      await GET(req());

      expect(sweepVerdict("cancelled-block reconcile")).toBe(4);
      expect(sweepVerdict("missing-block reconcile")).toBe(2);
      expect(deletionVerdict()).toEqual({ deleted: 3, failed: 1, held: 0 });
    });
  });
});

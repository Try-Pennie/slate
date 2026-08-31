/**
 * The lane glue for warehouse PII retention (#1180): auth, lock, the two
 * monitoring signals, and fail-loud.
 *
 * The sweep's own tests cover what it clears and every way it refuses. These
 * cover the part that decides whether a failure is ever SEEN, which is a separate
 * failure: a correct sweep wired to a lane that swallowed its throw, or that
 * stamped a heartbeat on the error path, would look healthy while the committed
 * retention window quietly stopped being honored.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const sweep = vi.hoisted(() => ({ sweepWarehousePii: vi.fn() }));
const lane = vi.hoisted(() => ({
  laneCompleted: vi.fn(async (_lane: string, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status: 200 }),
  ),
  alertRetentionSkipped: vi.fn(async () => {}),
  alertRetentionResumed: vi.fn(async () => {}),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/snowflake/warehouse-retention", () => sweep);
vi.mock("@/lib/snowflake/retention-lane", () => lane);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

const req = () => new Request("http://x/api/cron/prune-warehouse-pii") as never;

beforeEach(() => {
  vi.clearAllMocks();
  cron.isAuthorizedCron.mockReturnValue(true);
  locks.acquireLock.mockResolvedValue("lease");
  sweep.sweepWarehousePii.mockResolvedValue({
    cutoff: "2027-03-01T00:00:00.000Z",
    candidates: 0,
    cleared: 0,
    rowsByTable: {},
  });
});

describe("GET /api/cron/prune-warehouse-pii", () => {
  it("refuses an unauthorized caller and sweeps nothing", async () => {
    cron.isAuthorizedCron.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(sweep.sweepWarehousePii).not.toHaveBeenCalled();
  });

  it("stands down when another run holds the lock", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    await GET(req());
    expect(sweep.sweepWarehousePii).not.toHaveBeenCalled();
  });

  it("stamps the heartbeat and says it is clearing again on a real run", async () => {
    await GET(req());
    expect(lane.laneCompleted).toHaveBeenCalledWith("prune-warehouse-pii", expect.objectContaining({
      cleared: 0,
    }));
    expect(lane.alertRetentionResumed).toHaveBeenCalledWith("prune-warehouse-pii");
    expect(lane.alertRetentionSkipped).not.toHaveBeenCalled();
  });

  /**
   * The case the heartbeat is blind to: the lane runs, clears nothing, and answers
   * 200 forever because the warehouse credential is absent. Without its own alert
   * the mirror side of the retention window would stop with nothing saying so.
   */
  it("alerts, and does not claim to be clearing, when the mirror is not configured", async () => {
    sweep.sweepWarehousePii.mockResolvedValue({
      skipped: "mirror-not-configured",
      candidates: 0,
      cleared: 0,
      rowsByTable: {},
    });
    await GET(req());
    expect(lane.alertRetentionSkipped).toHaveBeenCalledWith("prune-warehouse-pii", "mirror not configured");
    expect(lane.alertRetentionResumed).not.toHaveBeenCalled();
    // Still stamps: the cron DID fire, and that is the only question the
    // dead-man's switch asks.
    expect(lane.laneCompleted).toHaveBeenCalled();
  });

  it("fails loud and withholds the heartbeat when the sweep throws", async () => {
    sweep.sweepWarehousePii.mockRejectedValue(new Error("the sweep ran and did not clear everything"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    // The stamp is what a stale-lane watchdog reads. Stamping here would hide a
    // lane that fails every single night behind a fresh heartbeat.
    expect(lane.laneCompleted).not.toHaveBeenCalled();
  });

  it("releases the lock even when the sweep throws", async () => {
    sweep.sweepWarehousePii.mockRejectedValue(new Error("warehouse suspended"));
    await GET(req());
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_warehouse_pii", "lease");
  });

  it("reports the cleared count so a run can be read back", async () => {
    sweep.sweepWarehousePii.mockResolvedValue({
      cutoff: "2027-03-01T00:00:00.000Z",
      candidates: 3,
      cleared: 3,
      rowsByTable: { bookings: 3, booking_events: 1 },
    });
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ candidates: 3, cleared: 3 });
  });
});

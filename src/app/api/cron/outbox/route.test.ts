import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring for the outbox cron (#439): the lane runs the abandoned-pin GC sweep
// best-effort and includes its result. The sweep LOGIC is covered by
// scripts/test-booking-orchestration.ts; this exercises only the route glue.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const service = vi.hoisted(() => ({
  drainBookingOutbox: vi.fn(async () => ({ processed: 0 })),
  drainBookingReservations: vi.fn(async () => ({ processed: 0 })),
  sweepAbandonedReschedulePins: vi.fn(async () => ({ swept: 2, enqueued: 1 })),
  sweepAbandonedReassignIntents: vi.fn(async () => ({ swept: 1, enqueued: 1, dropped: 1 })),
}));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));
// #3077: the REAL sweep-failure reporter runs, over a streak counter that keeps a
// count per key the way `rate_limit_hit` does, so these tests prove the whole path
// from a thrown sweep to a page rather than that the route calls a mock.
const streak = vi.hoisted(() => {
  const counts = new Map<string, number>();
  return {
    counts,
    recordConsecutiveStreak: vi.fn(async (key: string, _windowS: number, alertAt: number) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n >= alertAt;
    }),
    clearFailureStreak: vi.fn(async (key: string) => {
      counts.delete(key);
    }),
  };
});
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  resolveRecovered: vi.fn(async (_r: { key: string; text: string }[]) => [] as string[]),
}));
const logged = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/google/sync-coalesce", () => ({ CRON_LOCK_TTL_MS: 1000 }));
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
vi.mock("@/lib/notify/streak", () => streak);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/log", () => logged);

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  streak.counts.clear();
});

describe("GET /api/cron/outbox", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(service.drainBookingOutbox).not.toHaveBeenCalled();
    expect(service.sweepAbandonedReschedulePins).not.toHaveBeenCalled();
  });

  it("runs the abandoned-pin GC sweep and includes its result", async () => {
    const res = await GET(req());
    expect(service.sweepAbandonedReschedulePins).toHaveBeenCalledTimes(1);
    expect((await res.json()).reschedulePins).toEqual({ swept: 2, enqueued: 1 });
  });

  it("runs the abandoned reassign-intent sweep (#518) and includes its result", async () => {
    const res = await GET(req());
    expect(service.sweepAbandonedReassignIntents).toHaveBeenCalledTimes(1);
    expect((await res.json()).reassignIntents).toEqual({ swept: 1, enqueued: 1, dropped: 1 });
  });

  it("does not break the drain if the reassign-intent sweep fails (best-effort)", async () => {
    service.sweepAbandonedReassignIntents.mockRejectedValueOnce(new Error("boom"));
    const res = await GET(req());
    const body = await res.json();
    expect(body.reassignIntents).toBeNull();
    expect(service.drainBookingOutbox).toHaveBeenCalledTimes(1);
  });

  it("does not break the drain if the sweep fails (best-effort)", async () => {
    service.sweepAbandonedReschedulePins.mockRejectedValueOnce(new Error("boom"));
    const res = await GET(req());
    const body = await res.json();
    expect(body.reschedulePins).toBeNull();
    expect(service.drainBookingOutbox).toHaveBeenCalledTimes(1);
  });

  // Multi-lane dead-man's switch (#685): a successful tick stamps THIS lane.
  it("stamps the 'outbox' heartbeat on a successful tick", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("outbox");
  });

  it("still returns 200 when the heartbeat stamp fails (best-effort)", async () => {
    heartbeat.recordHeartbeat.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });

  it("does not stamp a heartbeat when the caller is unauthorized", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    await GET(req());
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  // #3077. Each sweep used to be `.catch(() => null)`: nothing logged, nothing
  // paged, and the heartbeat still stamped, so a reservation drain throwing on every
  // tick left crashed lead bookings unresumed behind a lane answering 200.
  describe("a sweep that throws (#3077)", () => {
    const sweeps = [
      ["drainBookingReservations", "reservation_drain_failing"],
      ["sweepAbandonedReschedulePins", "reschedule_pin_sweep_failing"],
      ["sweepAbandonedReassignIntents", "reassign_intent_sweep_failing"],
    ] as const;

    it.each(sweeps)("logs %s's throw with the error itself", async (fn) => {
      const boom = new Error("boom");
      service[fn].mockRejectedValueOnce(boom);
      const res = await GET(req());
      expect(res.status).toBe(200);
      const call = logged.log.error.mock.calls.find((c) => c[0] === "outbox");
      expect(call).toBeDefined();
      expect(call![2]).toBe(boom);
    });

    it.each(sweeps)("pages %s as %s once the failing streak is sustained", async (fn, key) => {
      const failingTick = () => {
        service[fn].mockRejectedValueOnce(new Error("boom"));
        return GET(req());
      };
      // Short of the streak: counted, not paged.
      for (let i = 0; i < 4; i++) await failingTick();
      expect(dispatch.sendThrottledAlert.mock.calls.filter((c) => c[0] === key)).toHaveLength(0);
      await failingTick();
      const pages = dispatch.sendThrottledAlert.mock.calls.filter((c) => c[0] === key);
      expect(pages).toHaveLength(1);
      expect(pages[0]![2]).toContain("tag=outbox");
      // No other sweep was charged for it.
      for (const [, other] of sweeps) {
        if (other !== key) expect(streak.counts.get(other)).toBeUndefined();
      }
    });

    it("all-clears a sweep only from a tick where it returned a result", async () => {
      service.drainBookingReservations.mockRejectedValueOnce(new Error("boom"));
      await GET(req());
      const firstKeys = dispatch.resolveRecovered.mock.calls.flatMap((c) => c[0].map((r) => r.key));
      expect(firstKeys).not.toContain("reservation_drain_failing");
      await GET(req());
      const keys = dispatch.resolveRecovered.mock.calls.flatMap((c) => c[0].map((r) => r.key));
      expect(keys).toContain("reservation_drain_failing");
      expect(streak.counts.get("reservation_drain_failing")).toBeUndefined();
    });

    it("still answers 200 and stamps the heartbeat when the failure report throws", async () => {
      service.drainBookingReservations.mockRejectedValueOnce(new Error("boom"));
      streak.recordConsecutiveStreak.mockRejectedValueOnce(new Error("rpc down"));
      const res = await GET(req());
      expect(res.status).toBe(200);
      expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("outbox");
    });
  });
});

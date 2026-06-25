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
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/google/sync-coalesce", () => ({ CRON_LOCK_TTL_MS: 1000 }));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/outbox", () => {
  it("runs the abandoned-pin GC sweep and includes its result", async () => {
    const res = await GET(req());
    expect(service.sweepAbandonedReschedulePins).toHaveBeenCalledTimes(1);
    expect((await res.json()).reschedulePins).toEqual({ swept: 2, enqueued: 1 });
  });

  it("does not break the drain if the sweep fails (best-effort)", async () => {
    service.sweepAbandonedReschedulePins.mockRejectedValueOnce(new Error("boom"));
    const res = await GET(req());
    const body = await res.json();
    expect(body.reschedulePins).toBeNull();
    expect(service.drainBookingOutbox).toHaveBeenCalledTimes(1);
  });
});

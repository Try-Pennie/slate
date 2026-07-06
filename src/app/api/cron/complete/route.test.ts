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
const service = vi.hoisted(() => ({ completePastBookings: vi.fn(async () => 0) }));
const emit = vi.hoisted(() => ({ retryFailedDeliveries: vi.fn(async () => 0) }));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/webhooks/emit", () => emit);
vi.mock("@/lib/google/sync-coalesce", () => ({ CRON_LOCK_TTL_MS: 1000 }));

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
  });
});

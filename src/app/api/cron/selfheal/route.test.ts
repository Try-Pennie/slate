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
  reconcileCancelledBusyBlocks: vi.fn(async () => ({})),
  reconcileMissingBusyBlocks: vi.fn(async () => ({})),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/booking/service", () => service);

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/selfheal", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(service.processPendingEventDeletions).not.toHaveBeenCalled();
  });
});

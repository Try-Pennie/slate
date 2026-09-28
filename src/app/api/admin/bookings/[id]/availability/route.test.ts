import { describe, it, expect, vi, beforeEach } from "vitest";

// The admin move's times for an advisor link booking (#2827). Manager+ gated,
// keyed on the booking id inside the caller's OWN org, so staff never hold a
// lead's manage token and a booking in another org is refused like a missing
// one. The decisions are pinned by scripts/test-reschedule-times.ts.
const auth = vi.hoisted(() => ({
  requireManager: vi.fn(async () => ({ org_id: "org1" })),
}));
const live = vi.hoisted(() => ({ bookingRescheduleTimesLive: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/reschedule-times-live", () => live);
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import { GET } from "./route";
import { NotAuthorizedError } from "@/lib/auth/http";

beforeEach(() => vi.clearAllMocks());

const call = (id: string, qs = "") =>
  GET(new NextRequest(`http://localhost/api/admin/bookings/${id}/availability${qs}`), {
    params: Promise.resolve({ id }),
  });

describe("GET /api/admin/bookings/[id]/availability", () => {
  it("is manager gated and reads the booking inside the caller's own org", async () => {
    live.bookingRescheduleTimesLive.mockResolvedValue({
      status: 200,
      body: { bucket: { code: "" }, orgName: "Pennie", eventType: { name: "Call", description: null, durationMin: 30 }, slots: ["2099-01-01T15:00:00.000Z"], emptyBecause: null },
    });
    const res = await call("b1", "?from=2099-01-01T00:00:00.000Z");
    expect(res.status).toBe(200);
    expect((await res.json()).slots).toHaveLength(1);
    expect(auth.requireManager).toHaveBeenCalled();
    expect(live.bookingRescheduleTimesLive).toHaveBeenCalledWith(
      { bookingId: "b1", orgId: "org1" },
      { from: "2099-01-01T00:00:00.000Z", to: null },
      expect.any(Number),
    );
  });

  it("refuses a caller who is not manager+ before reading anything", async () => {
    auth.requireManager.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await call("b1");
    expect(res.status).toBe(403);
    expect(live.bookingRescheduleTimesLive).not.toHaveBeenCalled();
  });

  it("answers a refusal with its own status and body", async () => {
    live.bookingRescheduleTimesLive.mockResolvedValue({
      status: 404,
      body: { error: "We cannot offer new times for this call right now.", code: "RESCHEDULE_TIMES_UNAVAILABLE" },
    });
    const res = await call("b1");
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("RESCHEDULE_TIMES_UNAVAILABLE");
  });

  it("a fault is an internal error, never an empty week", async () => {
    live.bookingRescheduleTimesLive.mockRejectedValue(new Error("db down"));
    const res = await call("b1");
    expect(res.status).toBe(500);
  });
});

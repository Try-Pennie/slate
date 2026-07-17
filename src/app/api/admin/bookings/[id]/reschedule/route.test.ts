import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the admin reschedule route (#439): a concurrent reschedule that
// throws RescheduleConflictError maps to 409 with the distinct refresh message.
// requireBookingActor + adminRescheduleBooking are mocked so this exercises only the glue.
const auth = vi.hoisted(() => ({
  requireBookingActor: vi.fn(
    async (): Promise<{ userId: string; actingAsUserId: string | null }> => ({
      userId: "mgr1",
      actingAsUserId: null,
    }),
  ),
}));
const service = vi.hoisted(() => {
  class RescheduleConflictError extends Error {
    constructor() {
      super("This booking was just changed. Refresh and try again.");
      this.name = "RescheduleConflictError";
    }
  }
  class SlotUnavailableError extends Error {}
  class VerifyUnavailableError extends Error {}
  class RescheduleLockUnavailableError extends Error {
    constructor() {
      super("Could not lock this booking for reschedule. Please try again.");
      this.name = "RescheduleLockUnavailableError";
    }
  }
  class NoEligibleAgentsError extends Error {
    constructor(bucketCode: string) {
      super(`No eligible agents for bucket ${bucketCode}`);
      this.name = "NoEligibleAgentsError";
    }
  }
  return {
    adminRescheduleBooking: vi.fn(),
    RescheduleConflictError,
    SlotUnavailableError,
    VerifyUnavailableError,
    RescheduleLockUnavailableError,
    NoEligibleAgentsError,
  };
});

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/service", () => service);

import { POST } from "./route";
import { NotAuthorizedError } from "@/lib/auth/http";

function req(body: unknown): Parameters<typeof POST>[0] {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}
const params = { params: Promise.resolve({ id: "bk1" }) };

beforeEach(() => vi.clearAllMocks());

describe("POST /admin/bookings/[id]/reschedule", () => {
  it("is gated at manager level so managers (not just admins) can reschedule (#544)", async () => {
    service.adminRescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", status: "rescheduled" },
    });
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(200);
    expect(auth.requireBookingActor).toHaveBeenCalled();
  });

  it("returns 403 when the caller is not manager+ (denial branch, #606)", async () => {
    auth.requireBookingActor.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(403);
    expect(service.adminRescheduleBooking).not.toHaveBeenCalled();
  });

  it("records WHICH staff user rescheduled by threading the actor (#549)", async () => {
    auth.requireBookingActor.mockResolvedValueOnce({ userId: "admin1", actingAsUserId: "mgr2" });
    service.adminRescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", status: "rescheduled" },
    });
    await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(service.adminRescheduleBooking).toHaveBeenCalledWith(
      "bk1",
      "2026-07-01T15:00:00.000Z",
      expect.anything(),
      { userId: "admin1", actingAsUserId: "mgr2" },
    );
  });

  it("maps RescheduleConflictError to 409 with the conflict message", async () => {
    service.adminRescheduleBooking.mockRejectedValueOnce(new service.RescheduleConflictError());
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This booking was just changed. Refresh and try again.");
  });

  it("maps NoEligibleAgentsError to 409 (a full slot, not a crash) (#484)", async () => {
    service.adminRescheduleBooking.mockRejectedValueOnce(new service.NoEligibleAgentsError("411"));
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("411");
  });

  it("maps RescheduleLockUnavailableError to a retriable 503 (not a generic 500) (#479)", async () => {
    // Fail-closed lock claim on a transient DB error: safe to retry, so 503.
    service.adminRescheduleBooking.mockRejectedValueOnce(new service.RescheduleLockUnavailableError());
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Could not lock this booking for reschedule. Please try again.");
  });

  it("maps an unexpected failure to a generic 500 that does not leak internals (#598)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.adminRescheduleBooking.mockRejectedValueOnce(
      new Error('relation "public.bookings" does not exist'),
    );
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/bookings|does not exist/);
  });
});

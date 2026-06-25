import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the admin reschedule route (#439): a concurrent reschedule that
// throws RescheduleConflictError maps to 409 with the distinct refresh message.
// requireAdmin + adminRescheduleBooking are mocked so this exercises only the glue.
const auth = vi.hoisted(() => ({ requireAdmin: vi.fn(async () => {}) }));
const service = vi.hoisted(() => {
  class RescheduleConflictError extends Error {
    constructor() {
      super("This booking was just changed. Refresh and try again.");
      this.name = "RescheduleConflictError";
    }
  }
  class SlotUnavailableError extends Error {}
  class VerifyUnavailableError extends Error {}
  return {
    adminRescheduleBooking: vi.fn(),
    RescheduleConflictError,
    SlotUnavailableError,
    VerifyUnavailableError,
  };
});

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/service", () => service);

import { POST } from "./route";

function req(body: unknown): Parameters<typeof POST>[0] {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}
const params = { params: Promise.resolve({ id: "bk1" }) };

beforeEach(() => vi.clearAllMocks());

describe("POST /admin/bookings/[id]/reschedule", () => {
  it("maps RescheduleConflictError to 409 with the conflict message", async () => {
    service.adminRescheduleBooking.mockRejectedValueOnce(new service.RescheduleConflictError());
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This booking was just changed. Refresh and try again.");
  });
});

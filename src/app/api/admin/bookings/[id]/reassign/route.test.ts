import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the manager reassign route (#546/#555). requireBookingActor (the
// manager+ gate + #549 actor resolver) and adminReassignBooking are mocked so this
// exercises only the glue + error mapping. The at-cap error maps to a DISTINCT 409
// the UI recognizes to drive the two-step override.
const auth = vi.hoisted(() => ({
  requireBookingActor: vi.fn(
    async (): Promise<{ userId: string; actingAsUserId: string | null }> => ({
      userId: "mgr1",
      actingAsUserId: null,
    }),
  ),
}));
const service = vi.hoisted(() => {
  class DailyCapExceededError extends Error {
    agentEmail: string;
    day: string;
    constructor(agentEmail: string, day: string) {
      super(`Agent ${agentEmail} is at their daily cap on ${day}`);
      this.name = "DailyCapExceededError";
      this.agentEmail = agentEmail;
      this.day = day;
    }
  }
  return { adminReassignBooking: vi.fn(), DailyCapExceededError };
});

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/service", () => service);

import { POST } from "./route";

function req(body: unknown): Parameters<typeof POST>[0] {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}
const params = { params: Promise.resolve({ id: "bk1" }) };

beforeEach(() => vi.clearAllMocks());

describe("POST /admin/bookings/[id]/reassign", () => {
  it("is manager-gated and reassigns on success", async () => {
    service.adminReassignBooking.mockResolvedValueOnce({
      booking: { id: "bk1", agent_email: "b@x.com", starts_at: "2026-07-01T15:00:00.000Z", status: "rescheduled" },
      overCap: false,
    });
    const res = await POST(req({ agentEmail: "b@x.com", reason: "owner_reassignment" }), params);
    expect(res.status).toBe(200);
    expect(auth.requireBookingActor).toHaveBeenCalled();
  });

  it("threads the actor, agent, reason and overrideCap into the service", async () => {
    auth.requireBookingActor.mockResolvedValueOnce({ userId: "admin1", actingAsUserId: "mgr2" });
    service.adminReassignBooking.mockResolvedValueOnce({
      booking: { id: "bk1", agent_email: "b@x.com", starts_at: "x", status: "rescheduled" },
      overCap: true,
    });
    await POST(req({ agentEmail: "b@x.com", reason: "coverage", overrideCap: true }), params);
    expect(service.adminReassignBooking).toHaveBeenCalledWith(
      "bk1",
      "b@x.com",
      expect.objectContaining({ code: "coverage" }),
      { userId: "admin1", actingAsUserId: "mgr2" },
      true,
    );
  });

  it("maps the at-cap error to a DISTINCT 409 the UI can detect for the two-step", async () => {
    service.adminReassignBooking.mockRejectedValueOnce(new service.DailyCapExceededError("b@x.com", "2026-07-01"));
    const res = await POST(req({ agentEmail: "b@x.com", reason: "owner_reassignment" }), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("DAILY_CAP_EXCEEDED");
    expect(body.agentEmail).toBe("b@x.com");
  });

  it("rejects a missing agent with 400", async () => {
    const res = await POST(req({ reason: "owner_reassignment" }), params);
    expect(res.status).toBe(400);
    expect(service.adminReassignBooking).not.toHaveBeenCalled();
  });

  it("rejects an invalid reason with 400", async () => {
    const res = await POST(req({ agentEmail: "b@x.com", reason: "not_a_reason" }), params);
    expect(res.status).toBe(400);
    expect(service.adminReassignBooking).not.toHaveBeenCalled();
  });
});

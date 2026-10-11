import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for moving a rerouted call back (#3615). The decisions are node-tested in
// scripts/test-demotion-revert.ts; this exercises the glue: who may call it, which org it reads,
// how each outcome answers, and that a reassign refusal answers exactly as the reassign route's.
const auth = vi.hoisted(() => ({
  requireBookingActor: vi.fn(
    async (): Promise<{ userId: string; actingAsUserId: string | null }> => ({ userId: "mgr1", actingAsUserId: null }),
  ),
  currentUser: vi.fn(async () => ({ id: "mgr1", org_id: "org1", role: "manager" })),
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
  class Plain extends Error {}
  return {
    adminMoveBackDemotionReroute: vi.fn(),
    DailyCapExceededError,
    BookingNotFoundError: Plain,
    AgentNotAvailableError: Plain,
    BookingNotChangeableError: Plain,
    ReassignAcrossWorldsError: Plain,
  };
});

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/service", () => service);

import { POST } from "./route";
import { NotAuthorizedError } from "@/lib/auth/http";

const SAME_ORIGIN = { origin: "https://slate.trypennie.app", "sec-fetch-site": "same-origin", host: "slate.trypennie.app" };
function req(body: unknown, headers: Record<string, string> = SAME_ORIGIN): Parameters<typeof POST>[0] {
  return { json: async () => body, headers: new Headers(headers) } as unknown as Parameters<typeof POST>[0];
}
const params = { params: Promise.resolve({ id: "bk1" }) };

beforeEach(() => vi.clearAllMocks());

describe("POST /admin/bookings/[id]/move-back (#3615)", () => {
  it("moves the call back for a manager, in their own org, passing the over cap confirm through", async () => {
    service.adminMoveBackDemotionReroute.mockResolvedValueOnce({ kind: "moved-back", toUserId: "jordan" });
    const res = await POST(req({ overrideCap: true }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "moved-back", toUserId: "jordan" });
    expect(service.adminMoveBackDemotionReroute).toHaveBeenCalledWith(
      "bk1",
      "org1",
      { userId: "mgr1", actingAsUserId: null },
      true,
    );
  });

  it("treats a missing confirm as no override", async () => {
    service.adminMoveBackDemotionReroute.mockResolvedValueOnce({ kind: "moved-back", toUserId: "jordan" });
    await POST(req({}), params);
    expect(service.adminMoveBackDemotionReroute.mock.calls[0][3]).toBe(false);
  });

  it("answers a second press as done, not as a failure", async () => {
    service.adminMoveBackDemotionReroute.mockResolvedValueOnce({ kind: "already-recorded" });
    const res = await POST(req({}), params);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("already-recorded");
  });

  it("answers a refusal as a 409 carrying its reason, so the page can say which", async () => {
    service.adminMoveBackDemotionReroute.mockResolvedValueOnce({ kind: "refused", reason: "moved-since" });
    const res = await POST(req({}), params);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("moved-since");
  });

  it("answers a booking it cannot find as 404", async () => {
    service.adminMoveBackDemotionReroute.mockResolvedValueOnce({ kind: "not-found" });
    expect((await POST(req({}), params)).status).toBe(404);
  });

  it("answers an over cap original advisor with the reassign route's own distinct 409", async () => {
    service.adminMoveBackDemotionReroute.mockRejectedValueOnce(new service.DailyCapExceededError("j@x.com", "2026-10-14"));
    const res = await POST(req({}), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("DAILY_CAP_EXCEEDED");
  });

  it("refuses somebody who is not a manager before doing anything", async () => {
    auth.requireBookingActor.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await POST(req({}), params);
    expect(res.status).toBe(403);
    expect(service.adminMoveBackDemotionReroute).not.toHaveBeenCalled();
  });

  it("refuses a request from another site before reading anything", async () => {
    const res = await POST(req({}, { ...SAME_ORIGIN, origin: "https://evil.example", "sec-fetch-site": "cross-site" }), params);
    expect(res.status).toBe(403);
    expect(auth.requireBookingActor).not.toHaveBeenCalled();
  });

  it("refuses a body that is not an object of the expected shape", async () => {
    const res = await POST(req({ overrideCap: "yes" }), params);
    expect(res.status).toBe(400);
    expect(service.adminMoveBackDemotionReroute).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Auth guard for the agent-reassign bearer route (#9, #676). This route does NOT
// use the shared authenticateBearer helper, so that helper's coverage does not
// transfer, so the denial branches are pinned here directly. The real
// bearerTokenMatches is exercised (not mocked) so the constant-time compare is
// part of the test; only the env key and the mutating service call are stubbed.
const env = vi.hoisted(() => ({ reassignApiKey: vi.fn(() => "k3y") }));
const service = vi.hoisted(() => ({ reassignBooking: vi.fn() }));

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/booking/service", () => service);

import { POST } from "./route";

function req(opts: { auth?: string; body?: unknown }) {
  return {
    headers: { get: (k: string) => (k === "authorization" ? (opts.auth ?? null) : null) },
    json: async () => opts.body ?? {},
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  env.reassignApiKey.mockReturnValue("k3y");
  service.reassignBooking.mockResolvedValue({
    booking: {
      id: "b1",
      assigned_user_id: "u1",
      agent_email: "a@x.com",
      starts_at: "2026-07-10T15:00:00Z",
      status: "confirmed",
    },
    overCap: false,
  });
});

describe("POST /api/bookings/reassign", () => {
  it("returns 503 and does not reassign when the API key is not configured", async () => {
    env.reassignApiKey.mockReturnValueOnce("");
    const res = await POST(req({ auth: "Bearer k3y", body: { bookingId: "b1", agentEmail: "a@x.com" } }));
    expect(res.status).toBe(503);
    expect(service.reassignBooking).not.toHaveBeenCalled();
  });

  it("returns 401 and does not reassign when the Authorization header is missing", async () => {
    const res = await POST(req({ body: { bookingId: "b1", agentEmail: "a@x.com" } }));
    expect(res.status).toBe(401);
    expect(service.reassignBooking).not.toHaveBeenCalled();
  });

  it("returns 401 and does not reassign when the Bearer token is wrong", async () => {
    const res = await POST(req({ auth: "Bearer nope", body: { bookingId: "b1", agentEmail: "a@x.com" } }));
    expect(res.status).toBe(401);
    expect(service.reassignBooking).not.toHaveBeenCalled();
  });

  it("does not treat the key passed without the Bearer scheme as authorized", async () => {
    const res = await POST(req({ auth: "k3y", body: { bookingId: "b1", agentEmail: "a@x.com" } }));
    expect(res.status).toBe(401);
    expect(service.reassignBooking).not.toHaveBeenCalled();
  });

  it("returns 400 when authorized but required fields are missing", async () => {
    const res = await POST(req({ auth: "Bearer k3y", body: {} }));
    expect(res.status).toBe(400);
    expect(service.reassignBooking).not.toHaveBeenCalled();
  });

  it("reassigns when the Bearer token matches and the fields are present", async () => {
    const res = await POST(req({ auth: "Bearer k3y", body: { bookingId: "b1", agentEmail: "a@x.com" } }));
    expect(res.status).toBe(200);
    expect(service.reassignBooking).toHaveBeenCalledTimes(1);
  });
});

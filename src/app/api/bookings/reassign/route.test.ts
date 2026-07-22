import { describe, it, expect, vi, beforeEach } from "vitest";

// Auth guard for the agent-reassign bearer route (#9, #676). This route does NOT
// use the shared authenticateBearer helper, so that helper's coverage does not
// transfer, so the denial branches are pinned here directly. The real
// bearerTokenMatches is exercised (not mocked) so the constant-time compare is
// part of the test; only the env key and the mutating service call are stubbed.
const env = vi.hoisted(() => ({ reassignApiKey: vi.fn(() => "k3y") }));
const service = vi.hoisted(() => {
  // The route maps by typed error CLASS (not fragile substring matching, #621),
  // so the mock must expose the same classes the route does `instanceof` against.
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
  class BookingNotFoundError extends Error {
    constructor() {
      super("Booking not found");
      this.name = "BookingNotFoundError";
    }
  }
  class AgentNotAvailableError extends Error {
    constructor() {
      super("Agent not found or not bookable");
      this.name = "AgentNotAvailableError";
    }
  }
  class BookingNotChangeableError extends Error {
    constructor() {
      super("This booking can no longer be changed");
      this.name = "BookingNotChangeableError";
    }
  }
  return {
    reassignBooking: vi.fn(),
    DailyCapExceededError,
    BookingNotFoundError,
    AgentNotAvailableError,
    BookingNotChangeableError,
  };
});

// The reason store read is mocked so the test controls the active/retired set;
// validateReason (pure, from core) is exercised for real, not mocked (#988).
const reasonOpts = vi.hoisted(() => ({ loadReasonOptions: vi.fn() }));

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/booking/reason-options", () => reasonOpts);

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
  reasonOpts.loadReasonOptions.mockResolvedValue({
    reassign: {
      all: [
        { code: "owner_reassignment", label: "Owner reassignment" },
        { code: "coverage", label: "Coverage (agent unavailable)" },
        { code: "escalation", label: "Escalation" },
        { code: "other", label: "Other" },
      ],
      active: [],
    },
  });
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

  // Reason validation against the live store (#988). Same source of truth as the
  // six interactive sites (#346), but this is a machine path: an unknown code must
  // NOT fail the reassign, it normalizes to the default so booking_events stays clean.
  const reasonArg = () => service.reassignBooking.mock.calls[0][2];

  it("records the default owner_reassignment when no reason code is supplied", async () => {
    const res = await POST(req({ auth: "Bearer k3y", body: { bookingId: "b1", agentEmail: "a@x.com" } }));
    expect(res.status).toBe(200);
    expect(reasonArg()).toEqual({ code: "owner_reassignment", detail: null });
  });

  it("passes a valid store reason code through to the history event", async () => {
    const res = await POST(
      req({ auth: "Bearer k3y", body: { bookingId: "b1", agentEmail: "a@x.com", reasonCode: "escalation" } }),
    );
    expect(res.status).toBe(200);
    expect(reasonArg()).toEqual({ code: "escalation", detail: null });
  });

  it("normalizes an unknown/typo'd reason code to owner_reassignment instead of recording it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(
      req({ auth: "Bearer k3y", body: { bookingId: "b1", agentEmail: "a@x.com", reasonCode: "typpo_coverage" } }),
    );
    // The reassign still succeeds (the move is the critical operation)...
    expect(res.status).toBe(200);
    expect(service.reassignBooking).toHaveBeenCalledTimes(1);
    // ...but the bogus code never reaches booking_events.
    expect(reasonArg().code).toBe("owner_reassignment");
    expect(reasonArg().code).not.toBe("typpo_coverage");
  });

  // Error-contract mapping (#621): typed errors decide the status so the machine
  // caller can tell a genuine conflict (do not retry) from a transient outage
  // (retry). Substring routing used to send Google/DB outages back as a 409.
  const ok = { auth: "Bearer k3y", body: { bookingId: "b1", agentEmail: "a@x.com" } };

  it("maps a missing booking to 404 (genuine not-found, do not retry)", async () => {
    service.reassignBooking.mockRejectedValueOnce(new service.BookingNotFoundError());
    const res = await POST(req(ok));
    expect(res.status).toBe(404);
  });

  it("maps a missing/non-bookable target agent to 404", async () => {
    service.reassignBooking.mockRejectedValueOnce(new service.AgentNotAvailableError());
    const res = await POST(req(ok));
    expect(res.status).toBe(404);
  });

  it("maps a terminal (cancelled/completed) booking to 409, not a retryable 5xx", async () => {
    service.reassignBooking.mockRejectedValueOnce(new service.BookingNotChangeableError());
    const res = await POST(req(ok));
    expect(res.status).toBe(409);
  });

  it("maps the daily-cap conflict to a distinct 409 with a machine-readable code", async () => {
    service.reassignBooking.mockRejectedValueOnce(new service.DailyCapExceededError("a@x.com", "2026-07-10"));
    const res = await POST(req(ok));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("DAILY_CAP_EXCEEDED");
    expect(body.agentEmail).toBe("a@x.com");
  });

  it("maps a transient Google/DB outage to a retryable 5xx that does not leak internals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.reassignBooking.mockRejectedValueOnce(
      new Error('insert into "busy_blocks" failed: connection terminated unexpectedly'),
    );
    const res = await POST(req(ok));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await res.json()).error).not.toMatch(/busy_blocks|connection terminated/);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Auth guard for the agent-reassign bearer route (#9, #676). This route does NOT
// use the shared authenticateBearer helper, so that helper's coverage does not
// transfer, so the denial branches are pinned here directly. The real
// bearerTokenMatches is exercised (not mocked) so the constant-time compare is
// part of the test; only the env key and the mutating service call are stubbed.
const env = vi.hoisted(() => ({ reassignApiKey: vi.fn(() => "k3y"), reassignApiKey2: vi.fn(() => "") }));
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
  // #2660: a booking never crosses worlds. Present on the mock so the route's
  // error map can be reached; the mapping itself is pinned in the admin route's
  // suite, which drives the same mapper.
  class ReassignAcrossWorldsError extends Error {
    constructor() {
      super("A test booking can only move to a test agent, and a real booking to a real agent.");
      this.name = "ReassignAcrossWorldsError";
    }
  }
  return {
    reassignBooking: vi.fn(),
    DailyCapExceededError,
    BookingNotFoundError,
    AgentNotAvailableError,
    BookingNotChangeableError,
    ReassignAcrossWorldsError,
  };
});

// The reason store read is mocked so the test controls the active/retired set;
// validateReason (pure, from core) is exercised for real, not mocked (#988).
const reasonOpts = vi.hoisted(() => ({ loadReasonOptions: vi.fn() }));
// The unknown-code visibility alert (#993) is mocked so the test can assert it
// fires (or doesn't) without a real Slack/DB.
// sendThrottledAlert is also stubbed: the internal-error reporter (errors.ts) on the
// 5xx path posts through it, so leaving it out would throw in the outage test.
const dispatch = vi.hoisted(() => ({ sendThrottledInfo: vi.fn(), sendThrottledAlert: vi.fn() }));

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/booking/reason-options", () => reasonOpts);
vi.mock("@/lib/notify/dispatch", () => dispatch);

// NOT mocked: the owner-guard error classes the machine path raises (#2370). The
// route maps by class, so the test throws the REAL ones rather than a second set of
// look-alikes, which is the only way an `instanceof` here proves anything.
import {
  OwnerReassignRefusedError,
  OwnerReassignUnavailableError,
} from "@/lib/booking/owner-reassign-guard";
import { AttendeeEmailRefusedError } from "@/lib/booking/attendee-email-refused";
import { StaffPlacedReassignRefusedError } from "@/lib/booking/staff-placed-refused";
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
  dispatch.sendThrottledInfo.mockResolvedValue(undefined);
  dispatch.sendThrottledAlert.mockResolvedValue(undefined);
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
    // ...and it raises a visibility alert naming the bad code (#993), not just a log.
    expect(dispatch.sendThrottledInfo).toHaveBeenCalledTimes(1);
    expect(dispatch.sendThrottledInfo.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.stringContaining("typpo_coverage")]),
    );
  });

  it("does not alert when the reason code is valid or absent (#993)", async () => {
    await POST(req({ auth: "Bearer k3y", body: { bookingId: "b1", agentEmail: "a@x.com", reasonCode: "escalation" } }));
    await POST(req({ auth: "Bearer k3y", body: { bookingId: "b1", agentEmail: "a@x.com" } }));
    expect(dispatch.sendThrottledInfo).not.toHaveBeenCalled();
  });

  it("still reassigns even if the unknown-code alert send fails (#993)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatch.sendThrottledInfo.mockRejectedValueOnce(new Error("slack down"));
    const res = await POST(
      req({ auth: "Bearer k3y", body: { bookingId: "b1", agentEmail: "a@x.com", reasonCode: "typpo_coverage" } }),
    );
    expect(res.status).toBe(200);
    expect(service.reassignBooking).toHaveBeenCalledTimes(1);
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

  // #3373: the machine caller is told the lead's email is why, under a code it can
  // branch on, and a 4xx so it stops retrying a reassign Google will always refuse.
  it("maps Google refusing the lead's email to a 422 ATTENDEE_EMAIL_REFUSED, not a retryable 5xx", async () => {
    service.reassignBooking.mockRejectedValueOnce(new AttendeeEmailRefusedError(new Error("google 400")));
    const res = await POST(req(ok));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("ATTENDEE_EMAIL_REFUSED");
  });

  // #4202: a call a coordinator placed on the placeholder is Regal's to hand on, so the
  // automation is told to stop, under a code it can branch on.
  it("maps a refused call on the placeholder to a 409 STAFF_PLACED, not a retryable 5xx", async () => {
    service.reassignBooking.mockRejectedValueOnce(new StaffPlacedReassignRefusedError());
    const res = await POST(req(ok));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("STAFF_PLACED");
  });

  it("maps the daily-cap conflict to a distinct 409 with a machine-readable code", async () => {
    service.reassignBooking.mockRejectedValueOnce(new service.DailyCapExceededError("a@x.com", "2026-07-10"));
    const res = await POST(req(ok));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("DAILY_CAP_EXCEEDED");
    expect(body.agentEmail).toBe("a@x.com");
  });

  // #2370: the machine path now REFUSES an owner who cannot take the call, and says
  // so with a stable code plus whether the handoff was opened by this call. Each of
  // the three is asserted separately: one message answering for another is how
  // somebody spends an afternoon on the wrong thing (L11).
  it.each([
    ["owner-not-found", "OWNER_NOT_FOUND", 404],
    ["owner-not-bookable", "OWNER_NOT_BOOKABLE", 409],
    ["owner-on-time-off", "OWNER_ON_TIME_OFF", 409],
  ] as const)("maps %s to %s with its own status and the handoff outcome", async (refusal, code, status) => {
    service.reassignBooking.mockRejectedValueOnce(new OwnerReassignRefusedError(refusal, "recorded"));
    const res = await POST(req(ok));
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.code).toBe(code);
    expect(body.refusal).toBe(refusal);
    expect(body.handoff).toBe("recorded");
    // The refusal never pretends a move happened.
    expect(body.booking).toBeUndefined();
  });

  it("reports a retried refusal as already-recorded, so it does not read as a second one", async () => {
    service.reassignBooking.mockRejectedValueOnce(
      new OwnerReassignRefusedError("owner-on-time-off", "already-recorded"),
    );
    const res = await POST(req(ok));
    expect(res.status).toBe(409);
    expect((await res.json()).handoff).toBe("already-recorded");
  });

  // A read that FAILED is not a refusal. Before #2370 an unreadable owner answered
  // the same 404 a missing one did, so the caller stopped retrying an outage.
  it.each(["booking", "owner", "time-off", "handoff"] as const)(
    "answers a retryable 503 when the %s step could not be completed",
    async (stage) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      service.reassignBooking.mockRejectedValueOnce(
        new OwnerReassignUnavailableError(stage, new Error('read failed [users]: connection terminated')),
      );
      const res = await POST(req(ok));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("OWNER_CHECK_UNAVAILABLE");
      expect(body.stage).toBe(stage);
      expect(body.refusal).toBeUndefined();
      // Never the underlying failure text (#598).
      expect(JSON.stringify(body)).not.toMatch(/connection terminated|users/);
      // Loud: a failing read here is a fault, not a business outcome (#1153).
      expect(dispatch.sendThrottledAlert).toHaveBeenCalled();
    },
  );

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

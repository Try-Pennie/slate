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
  // The route maps by typed error CLASS (via the shared mapReassignError, #717),
  // so the mock must expose the same classes the mapper does `instanceof` against.
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
  // #2660: a test booking may not move onto a real agent, nor a real one onto a
  // test agent.
  class ReassignAcrossWorldsError extends Error {
    constructor() {
      super("A test booking can only move to a test agent, and a real booking to a real agent.");
      this.name = "ReassignAcrossWorldsError";
    }
  }
  return {
    adminReassignBooking: vi.fn(),
    DailyCapExceededError,
    BookingNotFoundError,
    AgentNotAvailableError,
    BookingNotChangeableError,
    ReassignAcrossWorldsError,
  };
});

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/service", () => service);

import { POST } from "./route";
import { AgentHeldError } from "@/lib/booking/reroute";
import { AttendeeEmailRefusedError, ATTENDEE_EMAIL_REFUSED_STAFF } from "@/lib/booking/attendee-email-refused";
import { NotAuthorizedError } from "@/lib/auth/http";

/** Same-origin headers, which is what Slate's own UI sends. The route refuses a
 *  request that says it came from elsewhere (#1046), so every fake carries them;
 *  the refusal test below overrides them. */
const SAME_ORIGIN_HEADERS = {
  origin: "https://slate.trypennie.app",
  "sec-fetch-site": "same-origin",
  host: "slate.trypennie.app",
};
const CROSS_ORIGIN_HEADERS = {
  ...SAME_ORIGIN_HEADERS,
  origin: "https://evil.example",
  "sec-fetch-site": "cross-site",
};
function req(
  body: unknown,
  headers: Record<string, string> = SAME_ORIGIN_HEADERS,
): Parameters<typeof POST>[0] {
  return {
    json: async () => body,
    headers: new Headers(headers),
  } as unknown as Parameters<typeof POST>[0];
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

  // #3249: a hold ends by itself, so it is TRANSIENT in this file's classification: a
  // 503 with Retry-After, which the machine reassign caller sharing this mapper
  // retries, never the 409 that tells it to stop.
  it("maps a held advisor to a retriable 503 HELD naming when the hold ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T19:01:30Z"));
    service.adminReassignBooking.mockRejectedValueOnce(new AgentHeldError("2026-10-05T19:04:00Z"));
    const res = await POST(req({ agentEmail: "b@x.com", reason: "owner_reassignment" }), params);
    vi.useRealTimers();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("150");
    const body = await res.json();
    expect(body.code).toBe("HELD");
    expect(body.error).toBe("This advisor is held for a bucket correction until 3:04pm ET.");
    expect(body.heldUntil).toBe("2026-10-05T19:04:00Z");
  });

  // #3373: Google refused to invite the lead's stored address, so the target's
  // invite was never written. A 422 naming the email, never the generic 500, so a
  // manager stops retrying a move that cannot succeed. The class is the real one:
  // the shared mapper reads it from its own module, not through the service.
  it("maps Google refusing the lead's email to a 422 that names the email", async () => {
    service.adminReassignBooking.mockRejectedValueOnce(new AttendeeEmailRefusedError(new Error("google 400")));
    const res = await POST(req({ agentEmail: "b@x.com", reason: "owner_reassignment" }), params);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("ATTENDEE_EMAIL_REFUSED");
    expect(body.error).toBe(ATTENDEE_EMAIL_REFUSED_STAFF);
    expect(body.error).toMatch(/email address/);
  });

  // #2660: the refusal is a genuine conflict (retrying changes nothing), so it is
  // a 409 with its own code, and the message is the service's own sentence.
  it("maps a move across worlds to a 409 with its own code", async () => {
    service.adminReassignBooking.mockRejectedValueOnce(new service.ReassignAcrossWorldsError());
    const res = await POST(req({ agentEmail: "b@x.com", reason: "owner_reassignment" }), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ACROSS_WORLDS");
    expect(body.error).toMatch(/test booking/i);
  });

  it("returns 403 when the caller is not manager+ (denial branch, #606)", async () => {
    auth.requireBookingActor.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await POST(req({ agentEmail: "b@x.com", reason: "owner_reassignment" }), params);
    expect(res.status).toBe(403);
    expect(service.adminReassignBooking).not.toHaveBeenCalled();
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

  it("keeps the intended 'not found' message as a 404 (#598 leaves benign input errors)", async () => {
    service.adminReassignBooking.mockRejectedValueOnce(new service.AgentNotAvailableError());
    const res = await POST(req({ agentEmail: "gone@x.com", reason: "owner_reassignment" }), params);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Agent not found or not bookable");
  });

  it("maps a terminal (cancelled/completed) booking to a 409 conflict, not a 500 (#717)", async () => {
    service.adminReassignBooking.mockRejectedValueOnce(new service.BookingNotChangeableError());
    const res = await POST(req({ agentEmail: "b@x.com", reason: "owner_reassignment" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This booking can no longer be changed");
  });

  it("maps an unexpected failure to a generic 500 that does not leak internals (#598)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.adminReassignBooking.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "bookings_pkey"'),
    );
    const res = await POST(req({ agentEmail: "b@x.com", reason: "owner_reassignment" }), params);
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/constraint|bookings_pkey|duplicate key/);
  });
});

// #1046: the session cookie is this route's only credential, so a request that says
// it came from another site is refused before the auth check and before the body is
// read. The static guard (scripts/test-same-origin-coverage.ts) proves every
// cookie-authed mutation route carries the CALL; this proves the call on this route
// actually refuses rather than sitting unreachable behind an earlier return.
describe("admin reassign refuses a cross-origin request (#1046)", () => {
  it("403s a cross-site request without authenticating or writing", async () => {
    const res = await POST(req({ agentEmail: "b@x.com", reason: "owner_reassignment" }, CROSS_ORIGIN_HEADERS), params);

    expect(res.status).toBe(403);
    expect(auth.requireBookingActor).not.toHaveBeenCalled();
    expect(service.adminReassignBooking).not.toHaveBeenCalled();
  });

  it("still serves the same-origin request the UI sends", async () => {
    // The positive control: a guard that refused everything would pass the test
    // above while breaking the whole surface.
    const res = await POST(req({ agentEmail: "b@x.com", reason: "owner_reassignment" }), params);
    expect(res.status).not.toBe(403);
  });
});

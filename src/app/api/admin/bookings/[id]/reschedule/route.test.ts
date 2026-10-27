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
  class OutsideCallingWindowError extends Error {
    zone: string;
    constructor(zone: string) {
      super("outside the calling window");
      this.zone = zone;
    }
  }
  return {
    adminRescheduleBooking: vi.fn(),
    OutsideCallingWindowError,
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
import { AttendeeEmailRefusedError, ATTENDEE_EMAIL_REFUSED_STAFF } from "@/lib/booking/attendee-email-refused";
import { NotAuthorizedError } from "@/lib/auth/http";
import { DeadlineExceededError } from "@/lib/fetch-within-deadline";

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
      // #3401: the request's confirm line facts, carrying its profile.
      expect.objectContaining({ profile: expect.anything() }),
    );
  });

  // #3401: a staff time change writes the same `confirm answered` line a booking
  // does, saying it was a staff move.
  it("writes the confirm answered line for a staff time change (#3401)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    service.adminRescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", status: "rescheduled" },
    });
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    const lines = info.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes('msg="confirm answered"'));
    info.mockRestore();
    expect(res.status).toBe(200);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("tag=booking ");
    expect(lines[0]).toContain('confirm_kind="admin_move"');
    expect(lines[0]).toContain("status=200");
    expect(lines[0]).not.toContain("stages_run");
  });

  it("logs where a timed out staff time change's time went, with the booking's lead id (#3401)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    service.adminRescheduleBooking.mockImplementationOnce((async (...args: unknown[]) => {
      const facts = args[4] as { leadId?: string | null; profile?: { time: (s: string, fn: () => Promise<unknown>) => Promise<unknown> } };
      facts.leadId = "00QUi00000zhEUP";
      await facts.profile?.time("reschedule", async () => {});
      throw Object.assign(new service.VerifyUnavailableError("try again"), {
        cause: new DeadlineExceededError("google freeBusy", 8_000, null),
      });
    }) as never);
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    const lines = info.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes('msg="confirm answered"'));
    info.mockRestore();
    expect(res.status).toBe(503);
    expect(lines[0]).toContain('confirm_kind="admin_move"');
    expect(lines[0]).toContain("timed_out=true");
    expect(lines[0]).toContain('lead_id="00QUi00000zhEUP"');
    expect(lines[0]).toMatch(/stages="[^"]*reschedule:\d+\/1/);
    // This route runs no confirm budget, so nothing reported its calls: absent, never zero.
    expect(lines[0]).not.toContain("calls_made");
  });

  it("maps RescheduleConflictError to 409 with the conflict message", async () => {
    service.adminRescheduleBooking.mockRejectedValueOnce(new service.RescheduleConflictError());
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This booking was just changed. Refresh and try again.");
  });

  // #3373: the move's new invite was refused for the lead's stored address. The
  // same staff answer the reassign routes give, never the generic 500.
  it("maps Google refusing the lead's email to a 422 that names the email", async () => {
    service.adminRescheduleBooking.mockRejectedValueOnce(new AttendeeEmailRefusedError(new Error("google 400")));
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("ATTENDEE_EMAIL_REFUSED");
    expect(body.error).toBe(ATTENDEE_EMAIL_REFUSED_STAFF);
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

// #1046: the session cookie is this route's only credential, so a request that says
// it came from another site is refused before the auth check and before the body is
// read. The static guard (scripts/test-same-origin-coverage.ts) proves every
// cookie-authed mutation route carries the CALL; this proves the call on this route
// actually refuses rather than sitting unreachable behind an earlier return.
describe("admin reschedule refuses a cross-origin request (#1046)", () => {
  it("403s a cross-site request without authenticating or writing", async () => {
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }, CROSS_ORIGIN_HEADERS), params);

    expect(res.status).toBe(403);
    expect(auth.requireBookingActor).not.toHaveBeenCalled();
    expect(service.adminRescheduleBooking).not.toHaveBeenCalled();
  });

  it("still serves the same-origin request the UI sends", async () => {
    // The positive control: a guard that refused everything would pass the test
    // above while breaking the whole surface.
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).not.toBe(403);
  });
});

describe("the lead's calling window on an admin move (#2310)", () => {
  it("refuses with 422 and names the lead's zone, so staff know why", async () => {
    service.adminRescheduleBooking.mockRejectedValueOnce(new service.OutsideCallingWindowError("Pacific/Honolulu"));
    const res = await POST(req({ start: "2026-07-01T13:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("OUTSIDE_CALLING_WINDOW");
    expect(body.error).toContain("8:00am");
    expect(body.error).toContain("8:00pm");
    expect(body.error).toContain("Pacific/Honolulu");
  });
});

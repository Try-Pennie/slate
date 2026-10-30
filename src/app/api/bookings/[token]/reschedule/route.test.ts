import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the token reschedule route (#439): a concurrent reschedule that
// throws RescheduleConflictError must map to 409 with the distinct refresh
// message (NOT the generic 500). The conflict logic itself is covered by
// scripts/test-booking-orchestration.ts; this exercises only the route's mapping.
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
  class ContactRefusedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ContactRefusedError";
    }
  }
  // #2310: a new time outside the lead's calling window in the zone they sent.
  class OutsideCallingWindowError extends Error {
    zone: string;
    constructor(zone: string) {
      super("outside the calling window");
      this.zone = zone;
    }
  }
  // #3373: Google refused to invite the address stored on the booking.
  class AttendeeEmailRefusedError extends Error {
    readonly field = "email" as const;
    constructor(cause: unknown) {
      super("Enter a valid email address");
      this.name = "AttendeeEmailRefusedError";
      this.cause = cause;
    }
  }
  // #3569: the booking is (or became) terminal, so it can no longer be moved.
  class BookingNotChangeableError extends Error {
    constructor() {
      super("This booking can no longer be changed");
      this.name = "BookingNotChangeableError";
    }
  }
  // #3569: the manage token resolves to no booking.
  class BookingNotFoundError extends Error {
    constructor() {
      super("Booking not found");
      this.name = "BookingNotFoundError";
    }
  }
  return {
    ContactRefusedError,
    AttendeeEmailRefusedError,
    OutsideCallingWindowError,
    BookingNotChangeableError,
    BookingNotFoundError,
    rescheduleBooking: vi.fn(),
    pageBookingFailure: vi.fn(async (_err: unknown) => {}),
    bookingDetailExtras: vi.fn((_booking: unknown) => ({
      contact: { name: "Kris", email: "k@x.com", phone: "+12035615295" },
      calendarLinks: { google: "g", outlook: "o", office365: "m", ics: "i" },
    })),
    RescheduleConflictError,
    SlotUnavailableError,
    VerifyUnavailableError,
    RescheduleLockUnavailableError,
    NoEligibleAgentsError,
  };
});

const recordApiOutcome = vi.hoisted(() => vi.fn());
/** #1046: the two manage routes and the phone edit are the only unauthenticated
 *  write paths with no throttle. The limiter is mocked so these tests drive the
 *  route's reaction to a refusal rather than Cloudflare's counter. */
const rateLimit = vi.hoisted(() => ({ manageWithinLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rateLimit);

vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/monitor/record-api-outcome", () => ({ recordApiOutcome }));
// #3580: observe whether a reschedule 500/503 pages, and control test-ness. The REAL
// reportInternalError runs; only its Slack dispatch and the DB-backed resolver are mocked.
const dispatch = vi.hoisted(() => ({ sendThrottledAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/dispatch", () => dispatch);
const testTraffic = vi.hoisted(() => ({ isTestManageTokenForPaging: vi.fn(async () => false) }));
vi.mock("@/lib/monitor/test-traffic", () => testTraffic);
// The real reason read by default; one test makes it hang past the budget.
const reasonOptions = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock("@/lib/booking/reason-options", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/booking/reason-options")>();
  return {
    ...real,
    loadReasonOptions: async () => {
      if (reasonOptions.fail) throw reasonOptions.fail;
      return real.loadReasonOptions();
    },
  };
});

// #4391: the program lead move. Its decisions are pinned by
// scripts/test-program-lead-booking.ts; here it is a seam.
const programLeadMove = vi.hoisted(() => ({
  loadProgramLeadMoveContext: vi.fn(),
  moveProgramLeadLive: vi.fn(),
}));
vi.mock("@/lib/booking/program-lead-booking-service", () => programLeadMove);

import { POST } from "./route";
import { mintProgramLeadToken } from "@/lib/booking/program-lead-token";
import { PLACEHOLDER_DAY_FULL_CODE, PlaceholderDayFullError } from "@/lib/booking/program-lead-booking";
import { PROGRAM_PLACEHOLDER_OUTCOME } from "@/lib/monitor/booking-api-outcome";
// Deliberately NOT mocked: the point of #2373 is that the route branches on the real
// classification rather than on how an error happens to be worded.
import { BookingWriteFailedError } from "@/lib/booking/gated-write";
import { BOOKING_ERROR_COPY } from "@/lib/booking/booker-copy";
import { PARTNER_KEYS } from "@/lib/booking/partner-keys";
import { deadlineWithinBudget } from "@/lib/call-budget";
import { BOOKING_CONFIRM_BUDGET_MS } from "@/lib/booking/confirm-budget";

function req(body: unknown): Parameters<typeof POST>[0] {
  // A real Request: the route reads its body through the capped reader (#3135),
  // which reads the stream rather than calling json().
  return new Request("https://slate.test/api/bookings/tok1", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.9" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}
const params = { params: Promise.resolve({ token: "tok1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  // #3580: default to real traffic (pages), the safe direction; a test overrides it.
  testTraffic.isTestManageTokenForPaging.mockReset();
  testTraffic.isTestManageTokenForPaging.mockResolvedValue(false);
});

import { DeadlineExceededError } from "@/lib/fetch-within-deadline";

describe("POST /bookings/[token]/reschedule", () => {
  // #3102: the reason read happens BEFORE the route's try, under the confirm
  // budget, so a deadline there used to escape as an unhandled 500. It is the same
  // outage as one inside the move: the retryable 503 the page already shows,
  // counted and paged the same way.
  it("answers a deadline from a read before the try with the retryable 503 (#3102)", async () => {
    reasonOptions.fail = new DeadlineExceededError("supabase", 4000, {
      label: "the booking confirm",
      totalMs: 12_000,
    });
    try {
      const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("We hit a temporary issue confirming this time. Please try again in a moment.");
      expect(service.rescheduleBooking).not.toHaveBeenCalled();
      expect(service.pageBookingFailure).toHaveBeenCalledOnce();
      expect(recordApiOutcome).toHaveBeenCalledWith(
        "error",
        "",
        "reschedule_verify_unavailable",
        expect.objectContaining({ by: "manageToken", token: "tok1" }),
      );
    } finally {
      reasonOptions.fail = null;
    }
  });

  // #3401: a lead's time change writes the same `confirm answered` line a booking
  // does, saying it was a move, so its wait is measurable and a page about it has a
  // line to send its reader to.
  it("writes the confirm answered line for a time change (#3401)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    service.rescheduleBooking.mockRejectedValueOnce(new service.RescheduleConflictError());
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    const lines = info.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes('msg="confirm answered"'));
    info.mockRestore();
    expect(res.status).toBe(409);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("tag=booking ");
    expect(lines[0]).toContain('confirm_kind="move"');
    expect(lines[0]).toContain("status=409");
    expect(lines[0]).toMatch(/response_ms=\d+/);
    // Quick and not a timeout: no profile.
    expect(lines[0]).not.toContain("stages_run");
  });

  // #3401 with #3300: a time change that runs out of time says where it went, and
  // whose call it was, from the lead id the service learns off the booking.
  it("logs where a timed out time change's time went, with the booking's lead id (#3401)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.rescheduleBooking.mockImplementationOnce((async (...args: unknown[]) => {
      // The service is handed the request's facts last, as the booker's create is.
      const facts = args[6] as { leadId?: string | null; profile?: { time: (s: string, fn: () => Promise<unknown>) => Promise<unknown> } };
      facts.leadId = "00QUi00000zhEUP";
      await facts.profile?.time("reschedule", async () => {});
      throw Object.assign(new service.VerifyUnavailableError("try again"), {
        cause: new DeadlineExceededError("supabase", 0, { label: "the booking confirm", totalMs: 12_000 }),
      });
    }) as never);
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    const lines = info.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes('msg="confirm answered"'));
    info.mockRestore();
    expect(res.status).toBe(503);
    expect(lines[0]).toContain('confirm_kind="move"');
    expect(lines[0]).toContain("timed_out=true");
    expect(lines[0]).toContain('lead_id="00QUi00000zhEUP"');
    expect(lines[0]).toMatch(/stages="[^"]*reschedule:\d+\/1/);
    expect(lines[0]).toMatch(/stages="[^"]*route-checks:\d+\/1/);
    expect(lines[0]).toContain("calls_made=0");
  });

  it("leaves any other failure before the try exactly as it was", async () => {
    reasonOptions.fail = new Error("boom");
    try {
      await expect(
        POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params),
      ).rejects.toThrow("boom");
      expect(service.pageBookingFailure).not.toHaveBeenCalled();
    } finally {
      reasonOptions.fail = null;
    }
  });

  it("runs the lead's move under the confirm budget (#3102)", async () => {
    let wait: number | null = null;
    service.rescheduleBooking.mockImplementationOnce(async () => {
      wait = deadlineWithinBudget(60_000, "probe").waitMs;
      throw new service.RescheduleConflictError();
    });
    await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(wait).not.toBeNull();
    expect(wait!).toBeLessThanOrEqual(BOOKING_CONFIRM_BUDGET_MS);
  });

  // After a timeout the confirm budget is spent, so the failure path (the outcome
  // it records and the error it reports) runs under the cleanup allowance, or both
  // would fail at once and the failure would go unrecorded.
  it("records the failure under the cleanup allowance, not the spent confirm budget (#3102)", async () => {
    const labels: (string | undefined)[] = [];
    recordApiOutcome.mockImplementation(() => {
      labels.push(deadlineWithinBudget(60_000, "probe").reportAs.budget?.label);
    });
    service.rescheduleBooking.mockRejectedValueOnce(new service.RescheduleConflictError());
    await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(labels).toEqual(["the booking cleanup"]);
    recordApiOutcome.mockReset();
  });

  it("maps RescheduleConflictError to 409 with the conflict message", async () => {
    service.rescheduleBooking.mockRejectedValueOnce(new service.RescheduleConflictError());
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This booking was just changed. Refresh and try again.");
  });

  it("maps NoEligibleAgentsError to 409 (a full slot, not a crash) (#484)", async () => {
    service.rescheduleBooking.mockRejectedValueOnce(new service.NoEligibleAgentsError("411"));
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("411");
  });

  // #3569: a lead clicking a stale reschedule link on a call that already happened (or
  // was cancelled) is an EXPECTED refusal, not a crash. It must be a clean 409 that
  // never reaches the generic 500 and never pages the on-call.
  it("maps BookingNotChangeableError to 409 with its own reason, not a generic 500 that pages (#3569)", async () => {
    service.rescheduleBooking.mockRejectedValueOnce(new service.BookingNotChangeableError());
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("This booking can no longer be changed");
    // #1549: every 409 names its reason so a client never branches on the message.
    expect(body.reason).toBe("reschedule_terminal");
    expect(service.pageBookingFailure).not.toHaveBeenCalled();
  });

  // #3569: an unknown/garbage manage token is a 404, not a 500 that pages.
  it("maps BookingNotFoundError to 404, not a generic 500 that pages (#3569)", async () => {
    service.rescheduleBooking.mockRejectedValueOnce(new service.BookingNotFoundError());
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Booking not found");
    expect(service.pageBookingFailure).not.toHaveBeenCalled();
  });

  // #1549: two of the 409s mean "that time is not available" and one means "the
  // booking moved under you", and the lead-facing surfaces answer them in opposite
  // ways (one offers the soonest times still open, the other must not). The status
  // cannot tell them apart and the message must not be load-bearing, so each
  // refusal names its reason on the wire.
  it("names the refusal reason on every 409, so a client can tell a gone time from a moved booking", async () => {
    const cases: [Error, string][] = [
      [new service.SlotUnavailableError("gone"), "reschedule_slot_taken"],
      [new service.NoEligibleAgentsError("411"), "reschedule_no_eligible_agents"],
      [new service.RescheduleConflictError(), "reschedule_conflict"],
      // #3569: a terminal booking is a fourth 409 and names its reason too, so a
      // client can tell "this call is over" from "the booking moved under you".
      [new service.BookingNotChangeableError(), "reschedule_terminal"],
    ];
    for (const [err, reason] of cases) {
      service.rescheduleBooking.mockRejectedValueOnce(err);
      const res = await POST(
        req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }),
        params,
      );
      expect(res.status).toBe(409);
      expect((await res.json()).reason).toBe(reason);
    }
  });

  // #2373. The two are driven together: the commit's lost race and its failed write
  // both used to arrive as RescheduleConflictError, so the lead was told to refresh
  // and pick again by a statement that never ran, which no choice of theirs repairs.
  it("separates a commit that FAILED from one that lost the race (#2373)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    service.rescheduleBooking.mockRejectedValueOnce(new service.RescheduleConflictError());
    const raced = await POST(
      req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }),
      params,
    );
    const racedBody = await raced.json();

    service.rescheduleBooking.mockRejectedValueOnce(
      new BookingWriteFailedError("reschedule_commit", "statement timeout"),
    );
    const failed = await POST(
      req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }),
      params,
    );
    const failedBody = await failed.json();

    // A lost race is the lead's to act on, so it keeps its 409 and its own reason.
    expect(raced.status).toBe(409);
    expect(racedBody.reason).toBe("reschedule_conflict");
    // A failed write is not, so it is retriable and says nothing moved.
    expect(failed.status).toBe(503);
    expect(failedBody.error).toBe(BOOKING_ERROR_COPY.writeFailed);
    expect(failedBody.error).not.toMatch(/timeout/);
    // And neither answers for the other, on the wire or in the tally.
    expect(failed.status).not.toBe(raced.status);
    expect(failedBody.error).not.toBe(racedBody.error);
    expect(recordApiOutcome).toHaveBeenCalledWith(
      "error",
      "",
      "reschedule_conflict",
      expect.anything(),
    );
    expect(recordApiOutcome).toHaveBeenCalledWith(
      "error",
      "",
      "reschedule_write_failed",
      expect.anything(),
    );
  });

  it("refuses a new time outside the lead's calling window with its own reason and sentence (#2310)", async () => {
    service.rescheduleBooking.mockRejectedValueOnce(new service.OutsideCallingWindowError("Pacific/Honolulu"));
    const res = await POST(
      req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict", timezone: "Pacific/Honolulu" }),
      params,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.reason).toBe("reschedule_outside_calling_window");
    expect(body.error).toBe(BOOKING_ERROR_COPY.outsideCallingHours);
    expect(recordApiOutcome).toHaveBeenCalledWith("error", "", "reschedule_outside_calling_window", {
      by: "manageToken",
      token: "tok1",
    });
  });

  it("hands the zone the page is showing to the booking layer (#2310)", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    await POST(
      req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict", timezone: "Pacific/Honolulu" }),
      params,
    );
    expect(service.rescheduleBooking.mock.calls[0][5]).toBe("Pacific/Honolulu");
  });

  it("maps RescheduleLockUnavailableError to a retriable 503 (not a generic 500) (#479)", async () => {
    // A fail-closed lock claim (transient DB error) is safe to retry, so it must
    // read as 503 like a verify outage, not a hard 500.
    service.rescheduleBooking.mockRejectedValueOnce(new service.RescheduleLockUnavailableError());
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Could not lock this booking for reschedule. Please try again.");
  });

  it("returns the new time on success", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).startsAt).toBe("2026-07-01T15:00:00.000Z");
  });

  // #2644: the Booker posts this response to the host as the moved call's success
  // message, so it carries what a fresh booking's does: the id the host's booking
  // confirmed page looks the call up by, and the add to calendar links at the NEW
  // time. The contact stays off it, as it does on the fresh booking's (#2643).
  it("returns the id and the calendar links for the moved call, and not the contact", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    const body = await res.json();
    expect(body.id).toBe("bk1");
    expect(body.calendarLinks).toEqual({ google: "g", outlook: "o", office365: "m", ics: "i" });
    expect(body).not.toHaveProperty("contact");
    expect(service.bookingDetailExtras.mock.calls.at(-1)?.[0]).toMatchObject({ id: "bk1" });
  });

  // #2165: the confirmation after a move names who will call, which the move may
  // have changed, so it is read off the booking the move returned.
  it("names the advisor the moved call is now with, and null when it holds none", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z", agent_name: "Sam Advisor" },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect((await res.json()).advisorName).toBe("Sam Advisor");

    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    const none = await (await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params)).json();
    expect(none).toHaveProperty("advisorName");
    expect(none.advisorName).toBeNull();
  });

  // #2658: the moved call is announced to the host as rescheduleBookingSuccessfulV2
  // in the same shape as a fresh booking's event, `isTest` included, so a moved
  // test call is never reported as a real one. The flag is read off the booking's
  // own bucket by the booking layer, never off the caller (#2660).
  it("carries isTest for the moved call, read off its bucket", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok1",
      isTest: true,
    });
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect((await res.json()).isTest).toBe(true);

    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok1",
      isTest: false,
    });
    const real = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect((await real.json()).isTest).toBe(false);
  });

  // #2164: a lead who comes back and types different details is correcting them,
  // and the move is where that correction has to land.
  it("hands the details the lead typed to the booking layer", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok1",
      contactChanged: { name: false, email: true, phone: true },
    });
    const res = await POST(
      req({
        start: "2026-07-01T15:00:00.000Z",
        reason: "schedule_conflict",
        attendee: { name: "Dana", email: "new@example.com", phone: "2155559999" },
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(service.rescheduleBooking).toHaveBeenCalledWith(
      "tok1",
      "2026-07-01T15:00:00.000Z",
      expect.anything(),
      "customer",
      { name: "Dana", email: "new@example.com", phone: "2155559999" },
      // #2310: no zone on this request, so the booking layer judges the zone
      // the booking was made in.
      undefined,
      // #3401: the request's confirm line facts, carrying its profile.
      expect.objectContaining({ profile: expect.anything() }),
    );
    // Said back, so the screen can tell the lead what else this move changed.
    expect((await res.json()).contactChanged).toEqual({ name: false, email: true, phone: true });
  });

  it("hands the answered first name to the booking layer with the name (#2549)", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok1",
      contactChanged: { name: true, email: false, phone: false },
    });
    await POST(
      req({
        start: "2026-07-01T15:00:00.000Z",
        reason: "schedule_conflict",
        attendee: { name: "Mary Jo Smith", firstName: "Mary Jo" },
      }),
      params,
    );
    expect(service.rescheduleBooking.mock.calls.at(-1)?.[4]).toEqual({ name: "Mary Jo Smith", firstName: "Mary Jo" });
  });

  it("says nothing about the details when the move changed none of them", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok1",
      contactChanged: null,
    });
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    // Absent, not three falses: the caller's question is whether there is anything
    // to tell them, and a key that is always there invites a line that says nothing.
    expect(Object.keys(await res.json())).not.toContain("contactChanged");
  });

  it("refuses the whole move when a detail cannot be used, with the sentence about that value", async () => {
    service.rescheduleBooking.mockRejectedValueOnce(
      new service.ContactRefusedError("Enter a valid email address"),
    );
    const res = await POST(
      req({
        start: "2026-07-01T15:00:00.000Z",
        reason: "schedule_conflict",
        attendee: { email: "nope" },
      }),
      params,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Enter a valid email address");
  });

  // #3373: the move's invite was refused by Google for the address the booking
  // already holds. A refusal about the email, counted under its own code, never
  // reschedule_internal and a page, and not a 409 that would open the alternatives.
  it("answers Google refusing the stored email as a 422 about the email, not an internal error", async () => {
    service.rescheduleBooking.mockRejectedValueOnce(new service.AttendeeEmailRefusedError(new Error("google 400")));
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe(BOOKING_ERROR_COPY.moveEmailRefused);
    expect(body.reason).toBe("reschedule_attendee_email_refused");
    expect(recordApiOutcome).toHaveBeenCalledWith("error", "", "reschedule_attendee_email_refused", {
      by: "manageToken",
      token: "tok1",
    });
    expect(recordApiOutcome).not.toHaveBeenCalledWith("error", "", "reschedule_internal", expect.anything());
  });

  it("refuses a multi-megabyte detail before the booking layer sees it (#1034)", async () => {
    const res = await POST(
      req({
        start: "2026-07-01T15:00:00.000Z",
        reason: "schedule_conflict",
        attendee: { email: "a".repeat(5000) },
      }),
      params,
    );
    expect(res.status).toBe(400);
    expect(service.rescheduleBooking).not.toHaveBeenCalled();
  });

  it("rejects a missing reason with 400 without touching the booking layer (#326)", async () => {
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z" }), params);
    expect(res.status).toBe(400);
    expect(service.rescheduleBooking).not.toHaveBeenCalled();
  });

  it("rejects a reason outside the reschedule list with 400 (#326)", async () => {
    // A cancel-only code must not be accepted on the reschedule route.
    const res = await POST(
      req({ start: "2026-07-01T15:00:00.000Z", reason: "no_longer_interested" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(service.rescheduleBooking).not.toHaveBeenCalled();
  });

  it("returns 400 for an unparseable start without calling the booking layer (#622)", async () => {
    const res = await POST(req({ start: "garbage", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(400);
    expect(service.rescheduleBooking).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a generic 500 that does not leak internals (#598)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.rescheduleBooking.mockRejectedValueOnce(new Error('column "agent_id" does not exist'));
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/agent_id|does not exist/);
  });
});

// #1318: a lead moving their own call is a booking attempt, and until now every way
// that attempt could be refused was counted NOWHERE. One lost race is ordinary; a
// wave is the same shape as the 2026-08-06 cal.com failure, reached by leads who
// already have an appointment.
describe("POST /api/bookings/[token]/reschedule outcome tally (#1318)", () => {
  beforeEach(() => recordApiOutcome.mockClear());
  const outcomes = () => recordApiOutcome.mock.calls.map((c) => [c[0], c[2]]);

  const body = { start: "2026-07-01T15:00:00.000Z", reason: "other", reasonDetail: "x" };

  it("counts the SUCCESS as well, so the failure share stays a share", async () => {
    service.rescheduleBooking.mockResolvedValue({
      booking: { id: "bk1", starts_at: body.start, ends_at: body.start },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    await POST(req(body), params);
    // The half that is easy to leave out: counting only the refusals would inflate the
    // very number #1313 pages on, so the page would fire off a healthy day of moves.
    expect(outcomes()).toEqual([["rescheduled", null]]);
  });

  it("counts each refusal under its own code, so a page can name what is failing", async () => {
    const cases: [Error, string][] = [
      [new service.SlotUnavailableError("gone"), "reschedule_slot_taken"],
      [new service.RescheduleConflictError(), "reschedule_conflict"],
      [new service.NoEligibleAgentsError("411"), "reschedule_no_eligible_agents"],
      [new service.VerifyUnavailableError("down"), "reschedule_verify_unavailable"],
      [new service.RescheduleLockUnavailableError(), "reschedule_lock_unavailable"],
      // #3569: a terminal booking is counted in the failure share like the others,
      // just under its own code, so it no longer hides inside reschedule_internal.
      [new service.BookingNotChangeableError(), "reschedule_terminal"],
      [new Error("boom"), "reschedule_internal"],
    ];
    for (const [err, code] of cases) {
      recordApiOutcome.mockClear();
      service.rescheduleBooking.mockRejectedValue(err);
      await POST(req(body), params);
      expect(outcomes()).toEqual([["error", code]]);
    }
  });

  // #3569: an unknown token is bot-shaped (the token is unguessable, so a miss is a
  // hand-made request). Counting it would put that volume in the denominator the
  // failure SHARE is taken against, so like the 429 it is deliberately not counted.
  it("counts nothing for an unknown manage token (#3569)", async () => {
    recordApiOutcome.mockClear();
    service.rescheduleBooking.mockRejectedValue(new service.BookingNotFoundError());
    const res = await POST(req(body), params);
    expect(res.status).toBe(404);
    expect(outcomes()).toEqual([]);
  });

  it("counts nothing for a request the page could not have sent", async () => {
    recordApiOutcome.mockClear();
    const res = await POST(req({ start: 5 }), params);
    expect(res.status).toBe(400);
    // Deliberate (#1318): the manage page sends one fixed shape, so a body Slate
    // rejects is hand made. If the PAGE ever sent the wrong shape, every reschedule
    // would fail and the codes above would report it as a share within minutes.
    expect(outcomes()).toEqual([]);
  });
});

// #1046: token guessing is infeasible (nanoid(24), about 143 bits) and the reschedule
// lock bounds hammering one real booking, but a garbage token still bought an
// unauthenticated caller a database round trip per request with nothing counting them.
// A per address edge window bounds that. It fails OPEN by design, so the test that
// matters is the one proving a refusal actually stops the work.
describe("manage reschedule is throttled per address (#1046)", () => {
  it("429s a refused address before touching the booking layer", async () => {
    rateLimit.manageWithinLimit.mockResolvedValueOnce(false);
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);

    expect(res.status).toBe(429);
    expect(service.rescheduleBooking).not.toHaveBeenCalled();
  });

  it("serves an address inside the window", async () => {
    // The positive control: a throttle that refused everything would pass the test
    // above while taking the manage link away from every customer.
    rateLimit.manageWithinLimit.mockResolvedValueOnce(true);
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(res.status).not.toBe(429);
  });
});

// #2561: a lead's reschedule is a mutation, and its answer describes one booking at
// one moment, carrying the manage URL with it. Nothing between the browser and the
// Worker was told that, so a shared cache was free to keep it and hand it to the next
// reader. Every ending is asserted, not just the happy one: the header is applied by
// wrapping the handler rather than by stamping each return, and the thing worth
// proving about a wrapper is that a return nobody remembered still carries it (L96).
describe("reschedule answers are never stored (#2561)", () => {
  const VALID = { start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" };
  const noStore = (res: Response) => res.headers.get("cache-control");

  // `vi.clearAllMocks` clears the CALLS and leaves a queued `mockResolvedValueOnce`
  // in place, so an earlier test that queued one and never reached it answers the
  // first call made here instead of the mock this test set up. Reset the queue
  // rather than inherit it.
  beforeEach(() => service.rescheduleBooking.mockReset());

  it("on a successful move", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "b1", starts_at: "2026-07-01T15:00:00Z", ends_at: "2026-07-01T15:30:00Z" },
      manageUrl: "https://slate.trypennie.app/booking/manage/tok1",
    });
    const res = await POST(req(VALID), params);
    expect(res.status).toBe(200);
    expect(noStore(res)).toBe("no-store");
  });

  it("on a rejected body, which never reaches the booking layer", async () => {
    const res = await POST(req({ start: 42 }), params);
    expect(res.status).toBe(400);
    expect(noStore(res)).toBe("no-store");
  });

  it("on a throttled address, the one refusal a cache could replay for free", async () => {
    rateLimit.manageWithinLimit.mockResolvedValueOnce(false);
    const res = await POST(req(VALID), params);
    expect(res.status).toBe(429);
    expect(noStore(res)).toBe("no-store");
  });

  it("on a concurrent change, which answers 409 through its own branch", async () => {
    service.rescheduleBooking.mockRejectedValueOnce(new service.RescheduleConflictError());
    const res = await POST(req(VALID), params);
    expect(res.status).toBe(409);
    expect(noStore(res)).toBe("no-store");
  });

  it("on an unexpected fault, which returns through a different helper entirely", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.rescheduleBooking.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(req(VALID), params);
    expect(res.status).toBe(500);
    expect(noStore(res)).toBe("no-store");
  });
});

// #2659: the moved call's success message carries the same partner join keys a
// fresh booking's does, read off the booking that moved (whose prefill came from
// the page it was first booked on), so a host ends both outcomes the same way.
describe("POST /api/bookings/[token]/reschedule partner join keys (#2659)", () => {
  it("carries submissionId and regalProfileId from the moved booking's prefill", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: {
        id: "bk1",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:30:00.000Z",
        prefill: { [PARTNER_KEYS.submissionId]: "a0G5x00000AbCdEQAU", [PARTNER_KEYS.regalProfileId]: "rp_01HZY3" },
      },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    const res = await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params);
    expect(await res.json()).toMatchObject({ submissionId: "a0G5x00000AbCdEQAU", regalProfileId: "rp_01HZY3" });
  });

  it("answers null for each key the original page did not pass", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z", prefill: {} },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    const body = await (await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params)).json();
    expect(body.submissionId).toBeNull();
    expect(body.regalProfileId).toBeNull();
  });
});

// #2750: a moved call keeps the lead id it was FIRST booked under, and the host's
// confirmed page looks it up by that id (the by id lookup refuses a booking the
// caller's id does not own, #2657). So the move's response, which the Booker
// posts to the host, carries the booking's own stored ids, never the page's.
describe("POST /api/bookings/[token]/reschedule carries the booking's own identity (#2750)", () => {
  it("answers the ORIGINAL lead's salesforceId and externalId off the moved booking", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: {
        id: "bk1",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:30:00.000Z",
        salesforce_id: "00QOriginal0001",
        external_id: "00QOriginalExt1",
      },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    const body = await (await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params)).json();
    expect(body).toMatchObject({ id: "bk1", salesforceId: "00QOriginal0001", externalId: "00QOriginalExt1" });
  });

  it("answers null, never absent, for an id the booking does not hold", async () => {
    service.rescheduleBooking.mockResolvedValueOnce({
      booking: { id: "bk1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z", salesforce_id: null, external_id: null },
      manageUrl: "https://slate.test/booking/manage/tok1",
    });
    const body = await (await POST(req({ start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" }), params)).json();
    expect(body).toHaveProperty("salesforceId", null);
    expect(body).toHaveProperty("externalId", null);
  });
});

// #3580: the smoke canary reschedules its own test bookings on this path, so an
// INTERNAL/write fault paged production. The page is withheld only when the booking is
// POSITIVELY test traffic (resolved server-side from its bucket); a real one still
// pages, and an unreadable marker pages (covered in test-traffic.test.ts).
describe("#3580 test-traffic page suppression", () => {
  const BODY = { start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" };
  it("does NOT page a reschedule INTERNAL fault that is test traffic", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    testTraffic.isTestManageTokenForPaging.mockResolvedValue(true);
    service.rescheduleBooking.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(500);
    expect(testTraffic.isTestManageTokenForPaging).toHaveBeenCalledWith("tok1");
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("DOES page a reschedule INTERNAL fault that is real traffic", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    testTraffic.isTestManageTokenForPaging.mockResolvedValue(false);
    service.rescheduleBooking.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(500);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
  });

  it("does NOT page a reschedule WRITE failure that is test traffic", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    testTraffic.isTestManageTokenForPaging.mockResolvedValue(true);
    service.rescheduleBooking.mockRejectedValueOnce(new BookingWriteFailedError("reschedule_commit", "db down"));
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(503);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("DOES page a reschedule WRITE failure that is real traffic", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    testTraffic.isTestManageTokenForPaging.mockResolvedValue(false);
    service.rescheduleBooking.mockRejectedValueOnce(new BookingWriteFailedError("reschedule_commit", "db down"));
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(503);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
  });
});

// #4391: the one exception to #4203 lives HERE, the lead facing reschedule route, and
// only for a move token signed for this very booking of a program lead's.
describe("POST /bookings/[token]/reschedule for a program lead (#4391)", () => {
  const LEAD = "00Q000000000001";
  const BOOKING_ID = "6f1c2d3e-0000-4000-8000-000000000001";
  const SECRET = "p".repeat(64);
  const moveToken = (bookingId: string, salesforceId = LEAD) =>
    mintProgramLeadToken({ salesforceId, bookingId, secret: SECRET, nowMs: Date.now() }).value;
  const BODY = { start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict", timezone: "America/Chicago" };
  const ctx = (programLead: boolean) => ({
    booking: { id: BOOKING_ID, salesforce_id: LEAD, program_lead: programLead, manage_token: "tok1" },
    bucket: { code: "411", is_test: false },
    eventType: { duration_min: 30 },
  });
  const moved = (kind: string) => ({
    result: {
      booking: { id: BOOKING_ID, kind, agent_name: kind === "staff_placed" ? "Marcia" : "Agent A", starts_at: BODY.start, ends_at: "2026-07-01T15:30:00.000Z", prefill: {} },
      manageUrl: "https://slate.test/booking/manage/tok1",
      isTest: false,
    },
    path: kind === "staff_placed" ? "straight" : "real-slot",
    onPlaceholder: kind === "staff_placed",
  });

  beforeEach(() => {
    vi.stubEnv("PROGRAM_LEAD_TOKEN_SECRET", SECRET);
    programLeadMove.loadProgramLeadMoveContext.mockReset();
    programLeadMove.moveProgramLeadLive.mockReset();
  });

  it("moves a program lead's call through the program move, with the facts the ordinary move gets", async () => {
    programLeadMove.loadProgramLeadMoveContext.mockResolvedValueOnce(ctx(true));
    programLeadMove.moveProgramLeadLive.mockResolvedValueOnce(moved("staff_placed"));
    const res = await POST(req({ ...BODY, programLeadMoveToken: moveToken(BOOKING_ID) }), params);
    expect(res.status).toBe(200);
    expect(service.rescheduleBooking).not.toHaveBeenCalled();
    const [args] = programLeadMove.moveProgramLeadLive.mock.calls[0]!;
    expect(args).toMatchObject({ token: "tok1", startIso: BODY.start, zone: "America/Chicago" });
    expect(args.reason.code).toBe("schedule_conflict");
    const body = await res.json();
    expect(body.advisorName).toBeNull();
    expect(recordApiOutcome.mock.calls.map((c) => c[0])).toEqual([PROGRAM_PLACEHOLDER_OUTCOME.move]);
  });

  it("counts a program lead's move to a real advisor as the ordinary rescheduled", async () => {
    programLeadMove.loadProgramLeadMoveContext.mockResolvedValueOnce(ctx(true));
    programLeadMove.moveProgramLeadLive.mockResolvedValueOnce(moved("routed"));
    const res = await POST(req({ ...BODY, programLeadMoveToken: moveToken(BOOKING_ID) }), params);
    expect(res.status).toBe(200);
    expect(recordApiOutcome.mock.calls.map((c) => c[0])).toEqual(["rescheduled"]);
    expect((await res.json()).advisorName).toBe("Agent A");
  });

  it("answers a full day with its own code and sentence, never the taken time one", async () => {
    programLeadMove.loadProgramLeadMoveContext.mockResolvedValueOnce(ctx(true));
    programLeadMove.moveProgramLeadLive.mockRejectedValueOnce(new PlaceholderDayFullError("2026-07-01"));
    const res = await POST(req({ ...BODY, programLeadMoveToken: moveToken(BOOKING_ID) }), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("reschedule_placeholder_day_full");
    expect(body.code).toBe(PLACEHOLDER_DAY_FULL_CODE);
    expect(body.error).toBe(BOOKING_ERROR_COPY.placeholderDayFull);
  });

  // The exception is the token, verified against THIS booking, and the booking's own
  // mark: anything less is the ordinary shared move, which keeps #4203.
  it.each([
    ["no token", null, true],
    ["a token for another booking", "other-booking", true],
    ["a token for another lead", "other-lead", true],
    ["a new booking's token", "new", true],
    ["a booking that is not a program lead's", "good", false],
  ])("moves with the ordinary shared reschedule given %s", async (_label, kind, programLead) => {
    programLeadMove.loadProgramLeadMoveContext.mockResolvedValueOnce(ctx(programLead));
    service.rescheduleBooking.mockResolvedValueOnce(moved("routed").result);
    const token =
      kind === "other-booking" ? moveToken("6f1c2d3e-0000-4000-8000-000000000002")
        : kind === "other-lead" ? moveToken(BOOKING_ID, "00Q000000000002")
          : kind === "new" ? mintProgramLeadToken({ salesforceId: LEAD, bookingId: null, secret: SECRET, nowMs: Date.now() }).value
            : kind === "good" ? moveToken(BOOKING_ID)
              : null;
    const res = await POST(req({ ...BODY, ...(token ? { programLeadMoveToken: token } : {}) }), params);
    expect(res.status).toBe(200);
    expect(programLeadMove.moveProgramLeadLive).not.toHaveBeenCalled();
    expect(service.rescheduleBooking).toHaveBeenCalledTimes(1);
    if (token === null) expect(programLeadMove.loadProgramLeadMoveContext).not.toHaveBeenCalled();
  });
});

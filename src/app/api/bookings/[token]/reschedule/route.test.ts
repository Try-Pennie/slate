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
  return {
    ContactRefusedError,
    rescheduleBooking: vi.fn(),
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

import { POST } from "./route";
// Deliberately NOT mocked: the point of #2373 is that the route branches on the real
// classification rather than on how an error happens to be worded.
import { BookingWriteFailedError } from "@/lib/booking/gated-write";
import { BOOKING_ERROR_COPY } from "@/lib/booking/booker-copy";

function req(body: unknown): Parameters<typeof POST>[0] {
  return {
    json: async () => body,
    headers: new Headers({ "cf-connecting-ip": "203.0.113.9" }),
  } as unknown as Parameters<typeof POST>[0];
}
const params = { params: Promise.resolve({ token: "tok1" }) };

beforeEach(() => vi.clearAllMocks());

describe("POST /bookings/[token]/reschedule", () => {
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
    );
    // Said back, so the screen can tell the lead what else this move changed.
    expect((await res.json()).contactChanged).toEqual({ name: false, email: true, phone: true });
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
      [new Error("boom"), "reschedule_internal"],
    ];
    for (const [err, code] of cases) {
      recordApiOutcome.mockClear();
      service.rescheduleBooking.mockRejectedValue(err);
      await POST(req(body), params);
      expect(outcomes()).toEqual([["error", code]]);
    }
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

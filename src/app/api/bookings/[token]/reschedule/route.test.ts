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
  return {
    rescheduleBooking: vi.fn(),
    RescheduleConflictError,
    SlotUnavailableError,
    VerifyUnavailableError,
    RescheduleLockUnavailableError,
    NoEligibleAgentsError,
  };
});

const recordApiOutcome = vi.hoisted(() => vi.fn());
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/monitor/record-api-outcome", () => ({ recordApiOutcome }));

import { POST } from "./route";

function req(body: unknown): Parameters<typeof POST>[0] {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
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

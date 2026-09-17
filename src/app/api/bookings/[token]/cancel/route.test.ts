import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the public manage-link cancel route. A BookingNotCancellableError
// maps to 409 with its message; an unexpected fault must NOT leak internals to the
// lead (#598). cancelBooking is mocked; validateReason is the real thing.
const service = vi.hoisted(() => {
  class BookingNotCancellableError extends Error {
    constructor() {
      super("This booking can no longer be cancelled.");
      this.name = "BookingNotCancellableError";
    }
  }
  return { cancelBooking: vi.fn(), BookingNotCancellableError };
});

/** #1046: the two manage routes and the phone edit are the only unauthenticated
 *  write paths with no throttle. The limiter is mocked so these tests drive the
 *  route's reaction to a refusal rather than Cloudflare's counter. */
const rateLimit = vi.hoisted(() => ({ manageWithinLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rateLimit);

const recordApiOutcome = vi.hoisted(() => vi.fn());
vi.mock("@/lib/monitor/record-api-outcome", () => ({ recordApiOutcome }));

vi.mock("@/lib/booking/service", () => service);

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

describe("POST /bookings/[token]/cancel", () => {
  it("cancels on success", async () => {
    service.cancelBooking.mockResolvedValueOnce(true);
    const res = await POST(req({ reason: "schedule_conflict" }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  // #2373. The two causes below are driven TOGETHER, because the defect was that one
  // answered for the other: a failed write reached the lead as "Your call is
  // cancelled" while the booking, the invite and the advisor's slot all stood.
  it("tells the lead nothing changed when the write FAILED, and counts it (#2373)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.cancelBooking.mockRejectedValueOnce(
      new BookingWriteFailedError("cancel_claim", 'column "status" does not exist'),
    );
    const res = await POST(req({ reason: "schedule_conflict" }), params);

    // Retriable, never a 200 and never the generic 500: nothing was cancelled.
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBeUndefined();
    expect(body.error).toBe(BOOKING_ERROR_COPY.writeFailed);
    // The database's own text stays in the log and never reaches a screen.
    expect(body.error).not.toMatch(/column|does not exist/);
    expect(recordApiOutcome).toHaveBeenCalledWith(
      "error",
      "",
      "cancel_write_failed",
      expect.anything(),
    );
  });

  it("still reports a cancel that LOST the race as done, under its own count (#2373)", async () => {
    // Somebody else cancelled it first, so the lead's booking really is cancelled and
    // saying otherwise would be the opposite lie. It is counted apart, so a spike in
    // races is visible rather than filed as an ordinary cancel.
    service.cancelBooking.mockResolvedValueOnce(false);
    const res = await POST(req({ reason: "schedule_conflict" }), params);

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(recordApiOutcome).toHaveBeenCalledWith(
      "error",
      "",
      "cancel_lost_race",
      expect.anything(),
    );
  });

  it("counts a cancel this call actually made as a cancel (#2373)", async () => {
    // The denominator. Counting only the refusals would inflate the very share the
    // failure-rate window pages on.
    service.cancelBooking.mockResolvedValueOnce(true);
    await POST(req({ reason: "schedule_conflict" }), params);
    expect(recordApiOutcome).toHaveBeenCalledWith("cancelled", "", null, expect.anything());
  });

  it("rejects a missing reason with 400 without touching the booking layer (#326)", async () => {
    const res = await POST(req({}), params);
    expect(res.status).toBe(400);
    expect(service.cancelBooking).not.toHaveBeenCalled();
  });

  it("rejects a reason outside the cancel list with 400 (#326)", async () => {
    // A reschedule-only code must not be accepted on the cancel route.
    const res = await POST(req({ reason: "found_better_time" }), params);
    expect(res.status).toBe(400);
    expect(service.cancelBooking).not.toHaveBeenCalled();
  });

  it("maps BookingNotCancellableError to 409 with its message", async () => {
    service.cancelBooking.mockRejectedValueOnce(new service.BookingNotCancellableError());
    const res = await POST(req({ reason: "schedule_conflict" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This booking can no longer be cancelled.");
  });

  it("maps an unexpected failure to a generic 500 that does not leak internals (#598)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.cancelBooking.mockRejectedValueOnce(
      new Error("getaddrinfo ENOTFOUND googleapis.com"),
    );
    const res = await POST(req({ reason: "schedule_conflict" }), params);
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/googleapis|ENOTFOUND/);
  });
});

// #1046: token guessing is infeasible (nanoid(24), about 143 bits) and the reschedule
// lock bounds hammering one real booking, but a garbage token still bought an
// unauthenticated caller a database round trip per request with nothing counting them.
// A per address edge window bounds that. It fails OPEN by design, so the test that
// matters is the one proving a refusal actually stops the work.
describe("manage cancel is throttled per address (#1046)", () => {
  it("429s a refused address before touching the booking layer", async () => {
    rateLimit.manageWithinLimit.mockResolvedValueOnce(false);
    service.cancelBooking.mockResolvedValueOnce(true);
    const res = await POST(req({ reason: "schedule_conflict" }), params);

    expect(res.status).toBe(429);
    expect(service.cancelBooking).not.toHaveBeenCalled();
  });

  it("serves an address inside the window", async () => {
    // The positive control: a throttle that refused everything would pass the test
    // above while taking the manage link away from every customer.
    rateLimit.manageWithinLimit.mockResolvedValueOnce(true);
    service.cancelBooking.mockResolvedValueOnce(true);
    const res = await POST(req({ reason: "schedule_conflict" }), params);
    expect(res.status).not.toBe(429);
  });
});

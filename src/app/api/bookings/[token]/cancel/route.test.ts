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

vi.mock("@/lib/booking/service", () => service);

import { POST } from "./route";

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
    service.cancelBooking.mockResolvedValueOnce(undefined);
    const res = await POST(req({ reason: "schedule_conflict" }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
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
    service.cancelBooking.mockResolvedValueOnce(undefined);
    const res = await POST(req({ reason: "schedule_conflict" }), params);

    expect(res.status).toBe(429);
    expect(service.cancelBooking).not.toHaveBeenCalled();
  });

  it("serves an address inside the window", async () => {
    // The positive control: a throttle that refused everything would pass the test
    // above while taking the manage link away from every customer.
    rateLimit.manageWithinLimit.mockResolvedValueOnce(true);
    service.cancelBooking.mockResolvedValueOnce(undefined);
    const res = await POST(req({ reason: "schedule_conflict" }), params);
    expect(res.status).not.toBe(429);
  });
});

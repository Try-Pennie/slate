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

vi.mock("@/lib/booking/service", () => service);

import { POST } from "./route";

function req(body: unknown): Parameters<typeof POST>[0] {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
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

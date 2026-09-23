import { describe, it, expect, vi, beforeEach } from "vitest";
import { CALENDAR_COPY } from "@/lib/booking/booker-copy";

// The add to calendar file (#2643), served by the manage token so the "Apple / ICS"
// button on the booking confirmed page can be a plain link with no API key. The
// file's content is built and tested in scripts/test-booking-api.ts; what is pinned
// here is what the ROUTE decides: which bookings get a file, and what everybody
// else is told.
const service = vi.hoisted(() => ({
  getBookingByToken: vi.fn(),
  bookingIcs: vi.fn((_booking: unknown, _stampIso: string) => "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"),
}));
const errors = vi.hoisted(() => ({
  internalErrorResponse: vi.fn(async () => new Response("Something went wrong.", { status: 500 })),
}));
const rateLimit = vi.hoisted(() => ({ manageWithinLimit: vi.fn(async (_ip: string) => true) }));
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/api/errors", () => errors);

import { GET } from "./route";

function get(token = "tok1") {
  return GET(new Request(`http://localhost/api/bookings/${token}/ics`) as never, {
    params: Promise.resolve({ token }),
  });
}

const ctx = (status: string) => ({ booking: { id: "bk-1", status, manage_token: "tok1" }, bucket: {}, eventType: {} });

describe("GET /api/bookings/[token]/ics (#2643)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.manageWithinLimit.mockResolvedValue(true);
    service.getBookingByToken.mockResolvedValue(ctx("confirmed"));
  });

  it("serves the booking's calendar file as a download", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="pennie-call.ics"');
    // A moved call must not be answered from a cache with its old time.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    expect(service.getBookingByToken).toHaveBeenCalledWith("tok1");
    expect(service.bookingIcs.mock.calls[0][0]).toMatchObject({ id: "bk-1" });
  });

  it("serves a moved call too, at its current time", async () => {
    service.getBookingByToken.mockResolvedValue(ctx("rescheduled"));
    expect((await get()).status).toBe(200);
  });

  it("answers a cancelled call with 410 and says so, rather than a file for a meeting that is off", async () => {
    service.getBookingByToken.mockResolvedValue(ctx("cancelled"));
    const res = await get();
    expect(res.status).toBe(410);
    expect(await res.text()).toBe(CALENDAR_COPY.icsCancelled);
    expect(service.bookingIcs).not.toHaveBeenCalled();
  });

  it("answers an unknown token with 404 in the lead's own words", async () => {
    service.getBookingByToken.mockResolvedValue(null);
    const res = await get("nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(CALENDAR_COPY.icsNotFound);
  });

  it("refuses before any read when the address is over its limit", async () => {
    rateLimit.manageWithinLimit.mockResolvedValue(false);
    const res = await get();
    expect(res.status).toBe(429);
    expect(service.getBookingByToken).not.toHaveBeenCalled();
  });

  it("hands a failed read to the shared error response, never a blank file", async () => {
    service.getBookingByToken.mockRejectedValue(new Error("statement timeout"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(errors.internalErrorResponse).toHaveBeenCalled();
  });
});

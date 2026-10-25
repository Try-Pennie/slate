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
  bookingManageUrl: vi.fn((token: string) => `https://slate.example/booking/manage/${token}`),
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

  it("sends a cancelled call to its manage page, which already shows it as cancelled (#2648)", async () => {
    service.getBookingByToken.mockResolvedValue(ctx("cancelled"));
    const res = await get();
    // 303, so the browser follows with a GET whatever method asked, and never caches
    // the move: a call is cancelled once but the link lives in old emails for ever.
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://slate.example/booking/manage/tok1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The address comes from the shared builder, keyed on the token the lead holds.
    expect(service.bookingManageUrl).toHaveBeenCalledWith("tok1");
    expect(service.bookingIcs).not.toHaveBeenCalled();
  });

  // #3672: the booking API moved the call to another bucket, which cancelled the
  // booking this token names and made a new one. The lookup follows to the new one,
  // so the file is the call the lead HAS, never a redirect to "cancelled".
  it("serves the booking that replaced a moved one, from the old token", async () => {
    service.getBookingByToken.mockResolvedValue({
      booking: { id: "bk-new", status: "confirmed", manage_token: "tok-new" },
      bucket: {},
      eventType: {},
      followedToToken: "tok-new",
    });
    const res = await get("tok-old");
    expect(res.status).toBe(200);
    expect(service.bookingIcs.mock.calls[0][0]).toMatchObject({ id: "bk-new" });
  });

  it("sends an old token whose replacing booking was since cancelled to THAT booking's page", async () => {
    service.getBookingByToken.mockResolvedValue({
      booking: { id: "bk-new", status: "cancelled", manage_token: "tok-new" },
      bucket: {},
      eventType: {},
      followedToToken: "tok-new",
    });
    const res = await get("tok-old");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://slate.example/booking/manage/tok-new");
  });

  it("answers an unknown token with 404 in the lead's own words", async () => {
    service.getBookingByToken.mockResolvedValue(null);
    const res = await get("nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(CALENDAR_COPY.icsNotFound);
    // No booking, so no manage page to send them to.
    expect(service.bookingManageUrl).not.toHaveBeenCalled();
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

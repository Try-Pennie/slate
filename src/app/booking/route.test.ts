import { describe, it, expect, vi, beforeEach } from "vitest";

// Error mapping for the public embed booking route. Focus of #358: an
// empty/misconfigured bucket now throws NoEligibleAgentsError (was
// SlotUnavailableError) — the consumer must still see "no times" (409), not a
// 500. createBooking + rate-limit are mocked so this exercises only the route's
// validation + error mapping.

const service = vi.hoisted(() => {
  class SlotUnavailableError extends Error {}
  class VerifyUnavailableError extends Error {}
  class NoEligibleAgentsError extends Error {}
  return {
    createBooking: vi.fn(),
    findDuplicateBookingWarning: vi.fn(
      async (): Promise<{ startsAt: string; manageUrl: string } | null> => null,
    ),
    SlotUnavailableError,
    VerifyUnavailableError,
    NoEligibleAgentsError,
  };
});
const rateLimit = vi.hoisted(() => ({
  allowRequest: vi.fn(async () => true),
  refundRequest: vi.fn(async () => {}),
  clientIp: () => "203.0.113.1",
  BOOKING_RATE_RULES: [],
}));

vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/rate-limit", () => rateLimit);

import { POST } from "./route";

const VALID_BODY = {
  bucketCode: "411",
  start: "2026-07-01T15:00:00.000Z",
  timezone: "America/New_York",
  attendee: { name: "Dana Lee", email: "dana@example.com", phone: "2155550100" },
};

function post(body: unknown) {
  return POST(
    new Request("http://localhost/booking", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }) as never,
  );
}

describe("POST /booking (embed) error mapping", () => {
  beforeEach(() => {
    rateLimit.allowRequest.mockResolvedValue(true);
    service.createBooking.mockReset();
    service.findDuplicateBookingWarning.mockReset();
    service.findDuplicateBookingWarning.mockResolvedValue(null);
  });

  it("maps an empty/misconfigured pool to 409 (not 500)", async () => {
    service.createBooking.mockRejectedValue(new service.NoEligibleAgentsError("no advisors"));
    expect((await post(VALID_BODY)).status).toBe(409);
  });

  it("still maps a full slot to 409 and a verify outage to 503", async () => {
    service.createBooking.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));
    expect((await post(VALID_BODY)).status).toBe(409);
    service.createBooking.mockRejectedValueOnce(new service.VerifyUnavailableError("outage"));
    expect((await post(VALID_BODY)).status).toBe(503);
  });

  it("maps an unexpected failure to a generic 500 that does not leak internals (#598)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.createBooking.mockRejectedValueOnce(new Error('relation "buckets" does not exist'));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/buckets|does not exist/);
  });

  it("returns the booking on success", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "bk-1" });
  });

  it("passes the lead's other active booking through as duplicateWarning (#626)", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-2", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    service.findDuplicateBookingWarning.mockResolvedValue({
      startsAt: "2026-07-02T18:00:00.000Z",
      manageUrl: "https://slate.test/booking/manage/tok-old",
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "bk-2",
      duplicateWarning: {
        startsAt: "2026-07-02T18:00:00.000Z",
        manageUrl: "https://slate.test/booking/manage/tok-old",
      },
    });
    // Detection excludes the just-created booking and matches by attendee.
    expect(service.findDuplicateBookingWarning).toHaveBeenCalledWith(
      expect.objectContaining({ excludeBookingId: "bk-2" }),
    );
  });
});

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
  allowRequest: vi.fn(async (_key: string, _rules?: unknown) => true),
  refundRequest: vi.fn(async (_key: string, _rules?: unknown) => {}),
  bookingWithinLimit: vi.fn(async () => true),
  clientIp: () => "203.0.113.1",
  BOOKING_HOURLY_RATE_RULES: [{ prefix: "book:h", windowSeconds: 3600, max: 10 }],
  BOOKING_CONTACT_HOURLY_RATE_RULES: [{ prefix: "book:contact:h", windowSeconds: 3600, max: 5 }],
  // Real normalizer (pure): the route relies on its exact key shape, so mocking
  // it would let a key-shape regression pass. Two discriminated keys per contact.
  contactRateKeys: (a: { email?: string | null; phone?: string | null }) => {
    const keys: string[] = [];
    const email = (a.email ?? "").trim().toLowerCase();
    if (email) keys.push(`email:${email}`);
    const phone = (a.phone ?? "").replace(/\D/g, "");
    if (phone) keys.push(`phone:${phone}`);
    return keys;
  },
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
    rateLimit.allowRequest.mockReset();
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingWithinLimit.mockResolvedValue(true);
    rateLimit.refundRequest.mockClear();
    service.createBooking.mockReset();
    service.findDuplicateBookingWarning.mockReset();
    service.findDuplicateBookingWarning.mockResolvedValue(null);
  });

  it("returns 429 (without touching the DB or createBooking) when the per-minute edge limiter blocks", async () => {
    rateLimit.bookingWithinLimit.mockResolvedValueOnce(false);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(429);
    // Edge block short-circuits before the hourly DB cap and the booking itself.
    expect(rateLimit.allowRequest).not.toHaveBeenCalled();
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  it("returns 429 when the hourly DB cap blocks (checked after the edge limiter)", async () => {
    rateLimit.allowRequest.mockResolvedValueOnce(false);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(429);
    expect(rateLimit.bookingWithinLimit).toHaveBeenCalled();
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  // #962: the edge per-minute window has no refund path, so a transient server
  // outage (503) still consumes one of the lead's 3/min. A block is normally a
  // spammy visitor (not an incident, so no alert), but every booking 429 is logged
  // with its scope + ip at a queryable tag/level so a too-tight limit surfaces: a
  // cluster of edge-minute 429s from many distinct IPs is the signal.
  it("logs a queryable throttle line naming the edge-minute scope + ip (#962)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    rateLimit.bookingWithinLimit.mockResolvedValueOnce(false);

    const res = await post(VALID_BODY);

    expect(res.status).toBe(429);
    const line = info.mock.calls.map(String).find((l) => l.includes("tag=booking-rate-limit"));
    expect(line).toBeDefined();
    expect(line).toContain('scope="edge-minute"');
    expect(line).toContain('ip="203.0.113.1"');
    info.mockRestore();
  });

  it("logs the throttle line with the hourly scope when the DB cap blocks (#962)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    rateLimit.allowRequest.mockResolvedValueOnce(false);

    await post(VALID_BODY);

    const line = info.mock.calls.map(String).find((l) => l.includes("tag=booking-rate-limit"));
    expect(line).toContain('scope="hourly"');
    info.mockRestore();
  });

  it("refunds the hourly IP cap AND both per-contact caps on a verify outage, never the edge burst window (#1033)", async () => {
    service.createBooking.mockRejectedValueOnce(new service.VerifyUnavailableError("outage"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    // 1 IP-cap refund + 1 per email + 1 per phone: a server outage must not burn
    // the lead's contact budget any more than it burns their IP budget.
    expect(rateLimit.refundRequest).toHaveBeenCalledTimes(3);
    const keysRefunded = rateLimit.refundRequest.mock.calls.map((c) => c[0]);
    expect(keysRefunded).toContain("203.0.113.1");
    expect(keysRefunded).toContain("email:dana@example.com");
    expect(keysRefunded).toContain("phone:2155550100");
  });

  it("refunds the IP cap AND both contact keys on a taken-slot 409, which isn't the lead's fault (#1089)", async () => {
    service.createBooking.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(409);
    // Same refund set as the 503 verify-outage path: a slot grabbed by someone
    // else a moment earlier must not burn a real lead's IP or contact budget.
    expect(rateLimit.refundRequest).toHaveBeenCalledTimes(3);
    const keysRefunded = rateLimit.refundRequest.mock.calls.map((c) => c[0]);
    expect(keysRefunded).toContain("203.0.113.1");
    expect(keysRefunded).toContain("email:dana@example.com");
    expect(keysRefunded).toContain("phone:2155550100");
  });

  it("does NOT refund on an empty/misconfigured-pool 409 (NoEligibleAgents), which is not a retryable slot race (#1089)", async () => {
    service.createBooking.mockRejectedValueOnce(new service.NoEligibleAgentsError("no advisors"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(409);
    // An empty pool is a config problem, not a slot someone else just took, so a
    // retry won't help and we don't hand the budget back.
    expect(rateLimit.refundRequest).not.toHaveBeenCalled();
  });

  it("rejects a filled honeypot with a generic 400 and never creates a booking (#1033)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await post({ ...VALID_BODY, website: "https://spam.example" });
    expect(res.status).toBe(400);
    expect(service.createBooking).not.toHaveBeenCalled();
    // The rejection reveals nothing honeypot-specific (indistinguishable from a
    // schema failure) but IS logged at a queryable tag for observability.
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/honeypot|website|bot/i);
    const line = info.mock.calls.map(String).find((l) => l.includes("tag=booking-honeypot"));
    expect(line).toBeDefined();
    info.mockRestore();
  });

  it("an empty honeypot books normally (a real submission never trips it) (#1033)", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-hp", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const res = await post({ ...VALID_BODY, website: "" });
    expect(res.status).toBe(200);
    expect(service.createBooking).toHaveBeenCalled();
  });

  it("returns 429 when the per-contact cap blocks, after the IP cap and without creating a booking (#1033)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // IP key (a bare ip) passes; the per-contact email key is over its cap.
    rateLimit.allowRequest.mockImplementation(async (key: string) => !key.startsWith("email:"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(429);
    expect(service.createBooking).not.toHaveBeenCalled();
    const line = info.mock.calls.map(String).find((l) => l.includes("tag=booking-rate-limit"));
    expect(line).toContain('scope="contact"');
    info.mockRestore();
  });

  it("checks BOTH the IP cap and the per-contact caps on a normal booking (#1033)", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-c", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    await post(VALID_BODY);
    const keysChecked = rateLimit.allowRequest.mock.calls.map((c) => c[0]);
    expect(keysChecked).toContain("203.0.113.1"); // per-IP
    expect(keysChecked).toContain("email:dana@example.com"); // per-contact email
    expect(keysChecked).toContain("phone:2155550100"); // per-contact phone
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

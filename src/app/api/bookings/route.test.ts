import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP-level wiring for the direct booking API skeleton (#355): the route maps
// the pure auth verdict to 503 (unconfigured) / 401 (bad key), trips 429 when
// the per-key ceiling is exceeded, and otherwise returns 501 until the booking
// body lands. Auth/key logic itself is covered by scripts/test-booking-api-auth.ts;
// the rate-limit IO and env reads are mocked so this exercises only the glue.

const env = vi.hoisted(() => ({
  bookingApiKeyPrimary: vi.fn(() => ""),
  bookingApiKeySecondary: vi.fn(() => ""),
}));
const rateLimit = vi.hoisted(() => ({
  allowRequest: vi.fn(async (_key: string, _rules: unknown) => true),
  // Real derivation, not a stub: the per-IP ceiling (#597) is only as good as the IP it
  // keys on, and a faked clientIp would let a broken header order pass unnoticed.
  clientIp: (headers: Headers) =>
    headers.get("cf-connecting-ip")?.trim() ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown",
}));
const service = vi.hoisted(() => {
  class SlotUnavailableError extends Error {}
  class VerifyUnavailableError extends Error {}
  class NoEligibleAgentsError extends Error {}
  class UnknownBucketError extends Error {}
  return {
    bookViaApi: vi.fn(),
    previewBooking: vi.fn(),
    listBookings: vi.fn(),
    SlotUnavailableError,
    VerifyUnavailableError,
    NoEligibleAgentsError,
    UnknownBucketError,
  };
});

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/booking/service", () => service);

import { POST, GET } from "./route";
import {
  DIRECT_BOOKING_API_RATE_RULES,
  DIRECT_BOOKING_API_READ_RATE_RULES,
  DIRECT_BOOKING_API_IP_RATE_RULES,
} from "@/lib/rate-limit-core";

function result(outcome: string) {
  return {
    outcome,
    booking: {
      id: "bk-1",
      external_id: "lead-abc-123",
      starts_at: "2026-07-01T15:00:00.000Z",
      ends_at: "2026-07-01T15:30:00.000Z",
      status: "confirmed",
      agent_name: "Agent A",
      agent_email: "a@x.com",
    },
    manageUrl: "https://slate.test/booking/manage/tok",
  };
}

const VALID_BODY = {
  bucketCode: "411",
  start: "2026-07-01T15:00:00.000Z",
  timezone: "America/New_York",
  attendee: { name: "Dana Lee", email: "dana@example.com", phone: "2155550100" },
  salesforceId: "00Q5x000001abcEAA",
  externalId: "lead-abc-123",
};

function post(authorization?: string, body?: unknown, ip?: string) {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (ip) headers.set("cf-connecting-ip", ip);
  return POST(
    new Request("http://localhost/api/bookings", {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as never,
  );
}

describe("POST /api/bookings (auth skeleton)", () => {
  beforeEach(() => {
    env.bookingApiKeyPrimary.mockReturnValue("");
    env.bookingApiKeySecondary.mockReturnValue("");
    rateLimit.allowRequest.mockResolvedValue(true);
    service.bookViaApi.mockReset();
    service.bookViaApi.mockResolvedValue(result("created"));
    service.previewBooking.mockReset();
    service.previewBooking.mockResolvedValue({
      dryRun: true,
      outcome: "created",
      wouldAssign: { id: "u1", name: "Agent A", email: "a@x.com" },
      existingBookingId: null,
    });
    service.listBookings.mockReset();
    service.listBookings.mockResolvedValue({ items: [], nextCursor: null });
  });

  it("returns 503 when no key is configured (endpoint disabled)", async () => {
    const res = await post("Bearer anything");
    expect(res.status).toBe(503);
  });

  it("returns 401 for a wrong key when one is configured", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    const res = await post("Bearer wrong-secret");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the Authorization header is missing", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    const res = await post();
    expect(res.status).toBe(401);
  });

  it("authenticates the secondary key too (zero-downtime rotation)", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("old-secret");
    env.bookingApiKeySecondary.mockReturnValue("new-secret");
    const res = await post("Bearer new-secret", VALID_BODY);
    expect(res.status).toBe(200);
  });

  it("trips 429 when the per-key ceiling is exceeded", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    rateLimit.allowRequest.mockResolvedValue(false);
    const res = await post("Bearer real-secret");
    expect(res.status).toBe(429);
  });

  it("rate-limits on the matched key id, in its own bucket", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    await post("Bearer real-secret");
    expect(rateLimit.allowRequest).toHaveBeenCalledWith(
      "key:primary",
      DIRECT_BOOKING_API_RATE_RULES,
    );
  });

  // #597: per-key alone meant a leaked integrator key had a 6000/hr ceiling and no
  // second bound. The per-IP ceiling caps any single machine well below that.
  it("ALSO applies a per-IP ceiling, keyed on the client IP in a separate bucket", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    await post("Bearer real-secret", VALID_BODY, "203.0.113.9");
    expect(rateLimit.allowRequest).toHaveBeenCalledWith(
      "ip:203.0.113.9",
      DIRECT_BOOKING_API_IP_RATE_RULES,
    );
  });

  it("trips 429 on the per-IP ceiling even when the key is well within its budget", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    // The key is fine; only the IP is flooding. This is the leaked-key case.
    rateLimit.allowRequest.mockImplementation(async (key: string) => !key.startsWith("ip:"));

    const res = await post("Bearer real-secret", VALID_BODY, "203.0.113.9");

    expect(res.status).toBe(429);
    expect(service.bookViaApi).not.toHaveBeenCalled();
  });

  it("returns 400 for an authenticated call with an invalid body", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    const { externalId: _drop, ...noExternalId } = VALID_BODY;
    const res = await post("Bearer real-secret", noExternalId);
    expect(res.status).toBe(400);
  });

  it("surfaces attendee field errors on a bad-contact body", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret", {
      ...VALID_BODY,
      attendee: { name: "Dana", email: "", phone: "2155550100" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ fieldErrors: { email: expect.any(String) } });
  });

  it("routes a dryRun call to previewBooking and returns the preview (no booking)", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret", { ...VALID_BODY, dryRun: true });
    expect(res.status).toBe(200);
    expect(service.previewBooking).toHaveBeenCalledOnce();
    expect(service.bookViaApi).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ dryRun: true, outcome: "created", wouldAssign: { email: "a@x.com" } });
  });

  it("returns 200 with the booking on a created/deduped/rescheduled outcome", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    for (const outcome of ["created", "deduped", "rescheduled"]) {
      service.bookViaApi.mockResolvedValue(result(outcome));
      const res = await post("Bearer real-secret", VALID_BODY);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        outcome,
        booking: { id: "bk-1", externalId: "lead-abc-123" },
      });
    }
  });

  it("returns 409 on confirm_required so the bot can ask the lead first", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    service.bookViaApi.mockResolvedValue(result("confirm_required"));
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ outcome: "confirm_required" });
  });

  it("maps each booking error to a stable status + machine code", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    const cases: [Error, number, string][] = [
      [new service.UnknownBucketError("nope"), 422, "UNKNOWN_BUCKET"],
      [new service.NoEligibleAgentsError("empty"), 409, "NO_ELIGIBLE_AGENTS"],
      [new service.SlotUnavailableError("taken"), 409, "SLOT_TAKEN"],
      [new service.VerifyUnavailableError("outage"), 503, "VERIFY_UNAVAILABLE"],
      [new Error("boom"), 500, "INTERNAL"],
    ];
    for (const [err, status, code] of cases) {
      service.bookViaApi.mockRejectedValueOnce(err);
      const res = await post("Bearer real-secret", VALID_BODY);
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    }
  });

  it("tags an invalid body with the VALIDATION code", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    const { externalId: _drop, ...noExternalId } = VALID_BODY;
    const res = await post("Bearer real-secret", noExternalId);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION" });
  });

  it("does NOT leak the raw message on an INTERNAL 500, but keeps the code (#707)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    service.bookViaApi.mockRejectedValueOnce(new Error('relation "bookings" does not exist'));
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(body.error).not.toMatch(/bookings|does not exist/);
  });

  it("keeps the intended message on a typed error (SLOT_TAKEN) (#707)", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    service.bookViaApi.mockRejectedValueOnce(new service.SlotUnavailableError("That time was just taken."));
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("SLOT_TAKEN");
    expect(body.error).toBe("That time was just taken.");
  });
});

describe("GET /api/bookings (list mode + lookup mode)", () => {
  beforeEach(() => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    env.bookingApiKeySecondary.mockReturnValue("");
    rateLimit.allowRequest.mockClear();
    rateLimit.allowRequest.mockResolvedValue(true);
    service.listBookings.mockReset();
    service.listBookings.mockResolvedValue({ items: [], nextCursor: null });
  });

  function authedGet(url: string) {
    return GET(new Request(url, { headers: { authorization: "Bearer real-secret" } }) as never);
  }

  it("GET list mode (no externalId) returns the list payload", async () => {
    service.listBookings.mockResolvedValue({ items: [{ id: "bk-1", bucketCode: "411" }], nextCursor: null });
    const res = await authedGet("http://localhost/api/bookings?status=confirmed");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bookings: [{ id: "bk-1" }], nextCursor: null });
  });

  it("GET with blank externalId -> 400", async () => {
    const res = await authedGet("http://localhost/api/bookings?externalId=");
    expect(res.status).toBe(400);
  });

  it("GET with externalId + a list filter -> 400", async () => {
    const res = await authedGet("http://localhost/api/bookings?externalId=x&afterStart=2026-07-01T00:00:00Z");
    expect(res.status).toBe(400);
  });

  it("GET list mode requires auth (no key -> 401/503)", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("");
    const res = await GET(new Request("http://localhost/api/bookings") as never);
    expect([401, 503]).toContain(res.status);
  });

  it("GET (read) draws from the separate read rate ceiling, not the write one", async () => {
    await authedGet("http://localhost/api/bookings?status=confirmed");
    expect(rateLimit.allowRequest).toHaveBeenCalledWith("key:primary", DIRECT_BOOKING_API_READ_RATE_RULES);
    expect(rateLimit.allowRequest).not.toHaveBeenCalledWith("key:primary", DIRECT_BOOKING_API_RATE_RULES);
  });
});

// #597: reads deliberately do NOT get the per-IP ceiling. It is sized for the write path
// (60/min), while status polling is cheap, bursty, and runs against a ~10x larger per-key
// budget (#393). Applying it here would throttle the integrator's legitimate polling from
// their single host. Pinned so a well-meaning "make it consistent" change cannot quietly
// start 429ing reads.
describe("GET rate limiting (#597)", () => {
  beforeEach(() => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.allowRequest.mockClear();
    service.listBookings.mockResolvedValue({ items: [], nextCursor: null });
  });

  it("applies the READ per-key ceiling and no per-IP ceiling", async () => {
    await GET(
      new Request("http://localhost/api/bookings", {
        headers: new Headers({
          authorization: "Bearer real-secret",
          "cf-connecting-ip": "203.0.113.9",
        }),
      }) as never,
    );

    expect(rateLimit.allowRequest).toHaveBeenCalledWith(
      "key:primary",
      DIRECT_BOOKING_API_READ_RATE_RULES,
    );
    const keys = rateLimit.allowRequest.mock.calls.map(([k]) => k);
    expect(keys.every((k) => !String(k).startsWith("ip:"))).toBe(true);
  });
});

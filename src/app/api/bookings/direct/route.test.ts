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
const rateLimit = vi.hoisted(() => ({ allowRequest: vi.fn(async () => true) }));

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/rate-limit", () => rateLimit);

import { POST } from "./route";

const VALID_BODY = {
  bucketCode: "411",
  start: "2026-07-01T15:00:00.000Z",
  timezone: "America/New_York",
  attendee: { name: "Dana Lee", email: "dana@example.com", phone: "2155550100" },
  salesforceId: "00Q5x000001abcEAA",
  externalId: "lead-abc-123",
};

function post(authorization?: string, body?: unknown) {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  if (body !== undefined) headers.set("content-type", "application/json");
  return POST(
    new Request("http://localhost/api/bookings/direct", {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as never,
  );
}

describe("POST /api/bookings/direct (auth skeleton)", () => {
  beforeEach(() => {
    env.bookingApiKeyPrimary.mockReturnValue("");
    env.bookingApiKeySecondary.mockReturnValue("");
    rateLimit.allowRequest.mockResolvedValue(true);
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
    expect(res.status).toBe(501);
  });

  it("trips 429 when the per-key ceiling is exceeded", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    rateLimit.allowRequest.mockResolvedValue(false);
    const res = await post("Bearer real-secret");
    expect(res.status).toBe(429);
  });

  it("rate-limits on the matched key id, not the client IP", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    await post("Bearer real-secret");
    expect(rateLimit.allowRequest).toHaveBeenCalledWith(
      "key:primary",
      expect.any(Array),
    );
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

  it("returns 501 for a valid, in-budget call until the body is implemented", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});

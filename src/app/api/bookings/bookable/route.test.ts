import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP-level wiring for the validate-only bookable check (#541/#1017): the route
// shares the key-authed gate (so a bad key is 401 and the ceiling trips 429),
// validates startIso, falls back to the configured default bucket (400
// NO_DEFAULT_BUCKET when neither is present), and maps the check's outcomes:
// bookable true/false -> 200, unknown bucket -> 422, transient verify -> 503.
// The routing/verify logic itself is covered by scripts/test-booking-api.ts; the
// rate-limit IO, env, default-bucket read, and the check are mocked here.
const env = vi.hoisted(() => ({
  bookingApiKeyPrimary: vi.fn(() => "real-secret"),
  bookingApiKeySecondary: vi.fn(() => ""),
  bookingApiKeyFor: vi.fn((_caller: string, _slot: string) => ""),
}));
const rateLimit = vi.hoisted(() => ({
  allowRequest: vi.fn(async () => true),
  bookingApiWriteWithinLimit: vi.fn(async () => true),
  bookingApiReadWithinLimit: vi.fn(async () => true),
  bookingApiIpWithinLimit: vi.fn(async () => true),
  clientIp: (headers: Headers) => headers.get("cf-connecting-ip")?.trim() ?? "unknown",
}));
const service = vi.hoisted(() => {
  class VerifyUnavailableError extends Error {}
  class UnknownBucketError extends Error {}
  return {
    checkBookable: vi.fn(),
    VerifyUnavailableError,
    UnknownBucketError,
  };
});
const settings = vi.hoisted(() => ({ getDefaultBucketCode: vi.fn(async () => null as string | null) }));
const errors = vi.hoisted(() => ({
  GENERIC_ERROR_MESSAGE: "Something went wrong.",
  reportInternalError: vi.fn(async () => {}),
}));

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/booking/settings", () => settings);
vi.mock("@/lib/api/errors", () => errors);

import { GET } from "./route";

const OK = {
  bookable: true,
  reason: "available",
  effectiveBucketCode: "411",
  tierFallback: false,
  rungsDropped: 0,
  wouldAssign: { id: "u1", name: "Agent A", email: "a@x.com" },
  alternatives: { before: null, after: null },
};

function get(query: string, authorization = "Bearer real-secret") {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return GET(new Request(`http://localhost/api/bookings/bookable${query}`, { headers }) as never);
}

const VALID = "?bucketCode=411&startIso=2026-07-01T15:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  env.bookingApiKeyPrimary.mockReturnValue("real-secret");
  env.bookingApiKeySecondary.mockReturnValue("");
  rateLimit.allowRequest.mockResolvedValue(true);
  rateLimit.bookingApiReadWithinLimit.mockResolvedValue(true);
  rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
  service.checkBookable.mockResolvedValue(OK);
  settings.getDefaultBucketCode.mockResolvedValue(null);
});

describe("GET /api/bookings/bookable", () => {
  it("rejects a missing/bad key (401) and never runs the check", async () => {
    const res = await get(VALID, "");
    expect(res.status).toBe(401);
    expect(service.checkBookable).not.toHaveBeenCalled();
  });

  it("trips 429 when the per-key ceiling is exceeded", async () => {
    rateLimit.allowRequest.mockResolvedValue(false);
    const res = await get(VALID);
    expect(res.status).toBe(429);
    expect(service.checkBookable).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION when startIso is missing or unparseable", async () => {
    const missing = await get("?bucketCode=411");
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe("VALIDATION");
    const bad = await get("?bucketCode=411&startIso=nonsense");
    expect(bad.status).toBe(400);
  });

  it("returns 400 NO_DEFAULT_BUCKET when no bucketCode and no default is configured", async () => {
    settings.getDefaultBucketCode.mockResolvedValue(null);
    const res = await get("?startIso=2026-07-01T15:00:00.000Z");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_DEFAULT_BUCKET");
    expect(service.checkBookable).not.toHaveBeenCalled();
  });

  it("falls back to the configured default bucket when bucketCode is omitted", async () => {
    settings.getDefaultBucketCode.mockResolvedValue("200");
    const res = await get("?startIso=2026-07-01T15:00:00.000Z");
    expect(res.status).toBe(200);
    expect(service.checkBookable).toHaveBeenCalledWith(
      expect.objectContaining({ bucketCode: "200", allowTestBuckets: false }),
    );
    expect((await res.json()).requestedBucketCode).toBe("200");
  });

  it("returns 200 with the full result shape when bookable", async () => {
    const res = await get(VALID);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      bookable: true,
      reason: "available",
      requestedBucketCode: "411",
      effectiveBucketCode: "411",
      tierFallback: false,
      rungsDropped: 0,
      wouldAssign: { email: "a@x.com" },
      alternatives: { before: null, after: null },
    });
  });

  it("returns 200 bookable:false (a busy ladder is a normal answer, not an error)", async () => {
    service.checkBookable.mockResolvedValue({
      ...OK,
      bookable: false,
      reason: "slot_taken",
      effectiveBucketCode: null,
      wouldAssign: null,
    });
    const res = await get(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bookable: false, reason: "slot_taken" });
  });

  it("maps an unknown/hidden bucket to 422", async () => {
    service.checkBookable.mockRejectedValue(new service.UnknownBucketError());
    const res = await get(VALID);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("UNKNOWN_BUCKET");
  });

  it("maps a transient verify outage to 503, never a false 'not bookable'", async () => {
    service.checkBookable.mockRejectedValue(new service.VerifyUnavailableError());
    const res = await get(VALID);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("VERIFY_UNAVAILABLE");
  });

  it("maps an unexpected fault to a generic 500 and reports it", async () => {
    service.checkBookable.mockRejectedValue(new Error("boom: table does not exist"));
    const res = await get(VALID);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(body.error).toBe("Something went wrong.");
    expect(errors.reportInternalError).toHaveBeenCalled();
  });
});

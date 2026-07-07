import { describe, it, expect, vi, beforeEach } from "vitest";

// Public availability must HIDE synthetic test buckets (#396): a real lead (no
// booking key) gets the same 404 as an unknown bucket — no hint a hidden bucket
// exists — while the key-authed smoke test can still read its SMOKE slots.
// The hide is enforced INSIDE getBucketSlotsWithFallback, before the tier
// cascade, so the 404 timing matches an unknown code (#601); it returns null for
// an unauthorized test bucket. The route's job here is to resolve the bearer key
// and forward the right `authorizedForTest` flag, then 404 on a null result.
// Real (non-test) buckets stay public for everyone. Cache + rate-limit + env
// are mocked; the real api-auth verifies the bearer key.
//
// Rule #259: the `routing` block is intentionally absent from the public
// response — leads must never see tier-drop internals. `bucket.code` must
// always echo the REQUESTED code, even when the effective tier differs.

const cache = vi.hoisted(() => ({ getBucketSlotsWithFallback: vi.fn() }));
const rateLimit = vi.hoisted(() => ({
  availabilityWithinLimit: vi.fn(async () => true),
  clientIp: () => "203.0.113.7",
}));
const env = vi.hoisted(() => ({
  bookingApiKeyPrimary: () => "smoke-key",
  bookingApiKeySecondary: () => "",
}));

vi.mock("@/lib/availability/slot-cache", () => cache);
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/env", () => env);
// Pass slots through untouched so the min-notice window doesn't drop our fixtures.
vi.mock("@/lib/availability/compute", () => ({ filterSlotsFromNow: (s: string[]) => s }));

import { NextRequest } from "next/server";
import { GET } from "./route";

function slotsFor(isTest: boolean) {
  return {
    bucket: { code: "SMOKE", is_test: isTest },
    eventType: { name: "Smoke", description: null, duration_min: 30, min_notice_min: 0 },
    orgName: "Pennie",
    slots: ["2099-01-01T15:00:00.000Z"],
    routing: {
      requested_code: "SMOKE",
      effective_code: "SMOKE",
      tier_fallback: false,
      rungs_dropped: 0,
      requested_tier: null,
      booked_tier: null,
    },
  };
}

function get(bucket: string, authorization?: string) {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return GET(
    new NextRequest(`http://localhost/api/availability?bucket=${bucket}`, { headers }),
  );
}

describe("GET /api/availability test-bucket hiding (#396)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards authorizedForTest=false and 404s when an unauthenticated lead is hidden a test bucket", async () => {
    // The hide lives in getBucketSlotsWithFallback: unauthorized → null → 404.
    cache.getBucketSlotsWithFallback.mockResolvedValue(null);
    const res = await get("SMOKE");
    expect(res.status).toBe(404);
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith("SMOKE", expect.any(String), false);
  });

  it("forwards authorizedForTest=false when the bearer key is wrong", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(null);
    const res = await get("SMOKE", "Bearer not-the-key");
    expect(res.status).toBe(404);
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith("SMOKE", expect.any(String), false);
  });

  it("serves a test bucket's slots to the key-authed smoke test", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(true));
    const res = await get("SMOKE", "Bearer smoke-key");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slots).toHaveLength(1);
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith("SMOKE", expect.any(String), true);
  });

  it("serves a normal (non-test) bucket publicly with no auth", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    const res = await get("411");
    expect(res.status).toBe(200);
  });

  it("never exposes the routing block in the public response (#259)", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    const res = await get("SMOKE");
    const body = await res.json();
    expect(body).not.toHaveProperty("routing");
  });

  it("reports the requested bucket code even when a tier fallback fired (#259)", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue({
      bucket: { code: "LOW411", is_test: false },
      eventType: { name: "Smoke", description: null, duration_min: 30, min_notice_min: 0 },
      orgName: "Pennie",
      slots: ["2099-01-01T15:00:00.000Z"],
      routing: {
        requested_code: "SMOKE",
        effective_code: "LOW411",
        tier_fallback: true,
        rungs_dropped: 1,
        requested_tier: "high",
        booked_tier: "low",
      },
    });
    const res = await get("SMOKE");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Reported code must be the REQUESTED code, not the effective lower tier.
    expect(body.bucket.code).toBe("SMOKE");
    expect(body).not.toHaveProperty("routing");
  });
});

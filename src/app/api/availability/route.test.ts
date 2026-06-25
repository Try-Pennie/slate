import { describe, it, expect, vi, beforeEach } from "vitest";

// Public availability must HIDE synthetic test buckets (#396): a real lead (no
// booking key) gets the same 404 as an unknown bucket — no hint a hidden bucket
// exists — while the key-authed smoke test can still read its SMOKE slots.
// Real (non-test) buckets stay public for everyone. Cache + rate-limit + env
// are mocked; the real api-auth verifies the bearer key.

const cache = vi.hoisted(() => ({ getCachedBucketSlots: vi.fn() }));
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

  it("404s a test bucket for an unauthenticated lead", async () => {
    cache.getCachedBucketSlots.mockResolvedValue(slotsFor(true));
    const res = await get("SMOKE");
    expect(res.status).toBe(404);
  });

  it("404s a test bucket when the bearer key is wrong", async () => {
    cache.getCachedBucketSlots.mockResolvedValue(slotsFor(true));
    const res = await get("SMOKE", "Bearer not-the-key");
    expect(res.status).toBe(404);
  });

  it("serves a test bucket's slots to the key-authed smoke test", async () => {
    cache.getCachedBucketSlots.mockResolvedValue(slotsFor(true));
    const res = await get("SMOKE", "Bearer smoke-key");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slots).toHaveLength(1);
  });

  it("serves a normal (non-test) bucket publicly with no auth", async () => {
    cache.getCachedBucketSlots.mockResolvedValue(slotsFor(false));
    const res = await get("411");
    expect(res.status).toBe(200);
  });
});

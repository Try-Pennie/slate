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
// A spy (not a plain fn) so the fault tests below can make it throw.
const compute = vi.hoisted(() => ({ filterSlotsFromNow: vi.fn((s: string[]) => s) }));
vi.mock("@/lib/availability/compute", () => compute);

// internalErrorResponse stays REAL here: the 500 shape, the generic message and
// the per-route alert key are the behaviour under test, so mocking that helper
// would only assert this file's own copy of it (L52). Only its two side-effect
// dependencies are stubbed.
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _text: string): Promise<void> => {}),
);
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert }));
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { GENERIC_ERROR_MESSAGE } from "@/lib/api/errors";
import { GET } from "./route";

function slotsFor(isTest: boolean) {
  return {
    bucket: { code: "SMOKE", is_test: isTest },
    eventType: { name: "Smoke", description: null, duration_min: 30, min_notice_min: 0 },
    orgName: "Pennie",
    slots: ["2099-01-01T15:00:00.000Z"],
    source: "hit" as const,
    computedAt: "2026-07-20T12:00:00.000Z",
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

  // #257/#234: observability headers. source maps hit->hit, row->miss,
  // compute->nostore, and the row's computed_at is echoed for freshness.
  it("sets x-slot-cache=hit and x-slots-computed-at from a cache hit", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    const res = await get("411");
    expect(res.headers.get("x-slot-cache")).toBe("hit");
    expect(res.headers.get("x-slots-computed-at")).toBe("2026-07-20T12:00:00.000Z");
  });

  it("maps a cold compute to x-slot-cache=nostore", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue({ ...slotsFor(false), source: "compute" });
    const res = await get("411");
    expect(res.headers.get("x-slot-cache")).toBe("nostore");
  });

  it("maps an L2 row read to x-slot-cache=miss", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue({ ...slotsFor(false), source: "row" });
    const res = await get("411");
    expect(res.headers.get("x-slot-cache")).toBe("miss");
  });

  it("omits x-slots-computed-at when the freshness stamp is unknown", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue({ ...slotsFor(false), computedAt: null });
    const res = await get("411");
    expect(res.headers.get("x-slots-computed-at")).toBeNull();
    expect(res.headers.get("x-slot-cache")).toBe("hit");
  });

  it("reports the requested bucket code even when a tier fallback fired (#259)", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue({
      bucket: { code: "LOW411", is_test: false },
      eventType: { name: "Smoke", description: null, duration_min: 30, min_notice_min: 0 },
      orgName: "Pennie",
      slots: ["2099-01-01T15:00:00.000Z"],
      source: "hit" as const,
      computedAt: "2026-07-20T12:00:00.000Z",
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

// #1049: this route had no try/catch, so an unexpected throw became a framework
// 500 with no alert. It is the booker's hot path: a fault here shows a lead NO
// times, which is indistinguishable from a genuinely full calendar, and nobody
// was told. Every other public route routes an unpredicted fault through
// internalErrorResponse; this one must too.
describe("GET /api/availability unexpected faults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A healthy read by default, so each test below changes exactly one thing.
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    rateLimit.availabilityWithinLimit.mockResolvedValue(true);
  });

  it("returns the generic 500 and REPORTS when the slot read throws", async () => {
    cache.getBucketSlotsWithFallback.mockRejectedValueOnce(
      new Error('relation "bucket_slots" does not exist'),
    );

    const res = await get("411");

    expect(res.status).toBe(500);
    const body = await res.json();
    // Never the internal detail: not the table name, not the stack.
    expect(body.error).toBe(GENERIC_ERROR_MESSAGE);
    expect(JSON.stringify(body)).not.toContain("bucket_slots");
    // Silence is the actual defect being fixed, so assert someone is told, via
    // the real reporting path and its per-route key.
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert.mock.calls[0][0]).toBe("internal_error:availability");
  });

  it("reports a fault thrown by the slot filter too, not just the read", async () => {
    // The throw can come from anywhere downstream of the read; the whole handler
    // body has to be covered, not only the awaited call.
    compute.filterSlotsFromNow.mockImplementationOnce(() => {
      throw new TypeError("slots is not iterable");
    });

    const res = await get("411");

    expect(res.status).toBe(500);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
  });

  it("still 404s an unknown bucket rather than treating it as a fault", async () => {
    // The catch must not swallow the ordinary not-found path into a 500: a
    // mistyped bucket code is not an incident and must never page anyone.
    cache.getBucketSlotsWithFallback.mockResolvedValueOnce(null);

    const res = await get("999");

    expect(res.status).toBe(404);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("still 429s a throttled caller rather than treating it as a fault", async () => {
    rateLimit.availabilityWithinLimit.mockResolvedValueOnce(false);

    const res = await get("411");

    expect(res.status).toBe(429);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });
});

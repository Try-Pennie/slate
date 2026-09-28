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
  // #2854: only the canary's own key reads a hidden test bucket. Regal's key is
  // configured too, so the test below proves a partner's key is refused, not absent.
  bookingApiKeyFor: vi.fn((caller: string, slot: string) =>
    slot !== "primary" ? "" : caller === "canary" ? "smoke-key" : caller === "regal" ? "regal-key" : "",
  ),
  // #2666: the secret the public test bucket's pass is signed with.
  embedTestPassSecret: vi.fn(() => "t".repeat(64)),
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

// #1328: the empty-state reason. The pure decision lives in
// scripts/test-empty-reason.ts; what these mocks exist for is the ROUTE's part:
// that it asks only when the result is empty, and that a failed hours or horizon
// read degrades to null rather than failing the booker's hot path.
const hours = vi.hoisted(() => ({
  loadBusinessHoursCached: vi.fn(async () => ({
    zone: "America/New_York",
    rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 })),
    // #1363: no date exceptions in this fixture; the holiday-shutdown case has its
    // own suite (scripts/test-business-hours-exceptions.ts).
    exceptions: [],
    source: "stored" as const,
  })),
}));
const settings = vi.hoisted(() => ({ loadBookingHorizonDays: vi.fn(async () => 4) }));
// #2158: the pool count is the only thing that can tell an EMPTY bucket from a
// FULL one, since both produce the same empty slot list. Defaulted to a staffed
// pool so every pre-existing case keeps meaning what it meant.
const eligible = vi.hoisted(() => ({
  eligibleAgentIdsCached: vi.fn(async () => ({
    ids: ["u1", "u2"],
    fallbackApplied: false,
  })),
}));
vi.mock("@/lib/availability/eligible-cache", () => eligible);
vi.mock("@/lib/booking/business-hours-load", () => hours);
vi.mock("@/lib/booking/settings", () => settings);
// #2073: an agent's own booking link. The decisions are in
// scripts/test-agent-link-availability.ts; this proves the ROUTE hands the token
// to them, behind the same rate limit, and never touches the pooled cache.
const agentLink = vi.hoisted(() => ({ agentLinkAvailabilityLive: vi.fn() }));
vi.mock("@/lib/agent-link/service", () => agentLink);
// #2827: an advisor link booking's move times. The decisions are pinned by
// scripts/test-reschedule-times.ts; this proves the route hands the manage token
// to them, behind the same rate limit, and never touches the pooled cache.
const rescheduleTimes = vi.hoisted(() => ({ bookingRescheduleTimesLive: vi.fn() }));
vi.mock("@/lib/booking/reschedule-times-live", () => rescheduleTimes);

import { NextRequest } from "next/server";
import { GENERIC_ERROR_MESSAGE } from "@/lib/api/errors";
import { HIDDEN_TEST_BUCKET_CODES, PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
import { TEST_PASS_HEADER, TEST_PASS_REFUSAL_CODES } from "@/lib/embed/test-pass-header";
import { TEST_PASS_TTL_MS, mintTestPass } from "@/lib/embed/test-pass";
import { log } from "@/lib/log";
import { GET } from "./route";

const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];

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
      window_extended: false,
    },
  };
}

function get(bucket: string, authorization?: string, pass?: string) {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  if (pass) headers.set(TEST_PASS_HEADER, pass);
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

  it("hides a test bucket from a partner's key (#2854)", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(null);
    const res = await get("SMOKE", "Bearer regal-key");
    expect(res.status).toBe(404);
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith("SMOKE", expect.any(String), false);
  });

  it("serves a normal (non-test) bucket publicly with no auth", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    const res = await get("411");
    expect(res.status).toBe(200);
  });

  // #2660 opened the PUBLIC test bucket to any caller; #2666 narrows it to a page
  // `/book` approved, which carries a short lived pass. A browser still sends no
  // key: the pass is what it sends instead.
  const publicSlots = () => ({
    ...slotsFor(true),
    bucket: { code: PUBLIC_TEST, is_test: true },
    routing: { ...slotsFor(true).routing, requested_code: PUBLIC_TEST, effective_code: PUBLIC_TEST },
  });
  const goodPass = () =>
    mintTestPass({ code: PUBLIC_TEST, secret: env.embedTestPassSecret(), nowMs: Date.now() }).value;

  it("serves the public test bucket to a caller carrying a good pass", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(publicSlots());
    const res = await get(PUBLIC_TEST, undefined, goodPass());
    expect(res.status).toBe(200);
    expect((await res.json()).bucket).toEqual({ code: PUBLIC_TEST });
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith(PUBLIC_TEST, expect.any(String), true);
  });

  it("refuses the public test bucket with no pass, before reading anything", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(publicSlots());
    const res = await get(PUBLIC_TEST);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(TEST_PASS_REFUSAL_CODES.refused);
    expect(cache.getBucketSlotsWithFallback).not.toHaveBeenCalled();
    // The reason CLASS is logged, never a pass.
    expect(log.warn).toHaveBeenCalledWith(
      "embed-test",
      expect.objectContaining({ reason: "missing", route: "availability" }),
    );
  });

  it("refuses an expired pass with its own code", async () => {
    const stale = mintTestPass({
      code: PUBLIC_TEST,
      secret: env.embedTestPassSecret(),
      nowMs: Date.now() - TEST_PASS_TTL_MS - 1,
    }).value;
    const res = await get(PUBLIC_TEST, undefined, stale);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(TEST_PASS_REFUSAL_CODES.expired);
  });

  it("refuses the public test bucket as switched off when the deployment holds no secret", async () => {
    const pass = goodPass();
    env.embedTestPassSecret.mockReturnValueOnce("");
    const res = await get(PUBLIC_TEST, undefined, pass);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(TEST_PASS_REFUSAL_CODES.off);
  });

  it("a good pass for the public bucket presented with the canary's code still 404s", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(null);
    const res = await get(HIDDEN_TEST_BUCKET_CODES[0], undefined, goodPass());
    expect(res.status).toBe(404);
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith(
      HIDDEN_TEST_BUCKET_CODES[0],
      expect.any(String),
      false,
    );
  });

  it("the canary's key still reads the public test bucket with no pass", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(publicSlots());
    const res = await get(PUBLIC_TEST, "Bearer smoke-key");
    expect(res.status).toBe(200);
  });

  it("a real bucket needs no pass: the manage page and the admin panel read it bare", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    const res = await get("411");
    expect(res.status).toBe(200);
    expect(log.warn).not.toHaveBeenCalledWith("embed-test", expect.anything());
  });

  it("does not let the public test code authorise a hidden one: a near miss is still hidden", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(null);
    const res = await get(`${PUBLIC_TEST}2`);
    expect(res.status).toBe(404);
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith(`${PUBLIC_TEST}2`, expect.any(String), false);
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

// #1328: "All times are taken right now. Check back soon." is untrue in both
// halves when the reason is a closure. The route tells the booker which it is.
describe("GET /api/availability empty-state reason (#1328)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.availabilityWithinLimit.mockResolvedValue(true);
    compute.filterSlotsFromNow.mockImplementation((s: string[]) => s);
    hours.loadBusinessHoursCached.mockResolvedValue({
      zone: "America/New_York",
      rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 })),
      exceptions: [],
      source: "stored" as const,
    });
    settings.loadBookingHorizonDays.mockResolvedValue(4);
  });

  const emptyResult = {
    slots: [],
    orgName: "Pennie",
    eventType: { name: "Call", description: null, duration_min: 20, min_notice_min: 120 },
    routing: { requested_code: "411" },
    source: "hit" as const,
    computedAt: null,
  };

  it("says nothing about emptiness, and asks nothing, when there ARE times", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue({
      ...emptyResult,
      slots: ["2026-08-11T14:00:00.000Z"],
    });
    const body = await (await get("411")).json();

    expect(body.emptyBecause).toBeNull();
    // The ordinary hot path must not pay for a question it does not need to ask.
    expect(hours.loadBusinessHoursCached).not.toHaveBeenCalled();
  });

  it("reports busy when the org is open and nothing is free", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(emptyResult);
    const body = await (await get("411")).json();
    expect(body.emptyBecause).toEqual({ kind: "busy" });
  });

  it("reports a closure with the reopening day when every searched day is shut", async () => {
    // No open weekday at all, so every searched day is shut whatever today is.
    hours.loadBusinessHoursCached.mockResolvedValue({
      zone: "America/New_York",
      rules: [],
      exceptions: [],
      source: "stored" as const,
    });
    cache.getBucketSlotsWithFallback.mockResolvedValue(emptyResult);
    const body = await (await get("411")).json();
    expect(body.emptyBecause).toEqual({ kind: "closed", reopensOn: null });
  });

  // The failure path. This is the booker's hot path, and its worst failure mode is
  // showing a lead nothing at all, so a presentational reason must never be able to
  // take the request down: it degrades to null and the booker keeps the vaguer copy.
  it("degrades to no reason, still 200, when the hours read fails", async () => {
    hours.loadBusinessHoursCached.mockRejectedValue(new Error("business_hours is gone"));
    cache.getBucketSlotsWithFallback.mockResolvedValue(emptyResult);
    const res = await get("411");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.emptyBecause).toBeNull();
    // The slots themselves are unaffected: the reason is an extra, not a gate.
    expect(body.slots).toEqual([]);
  });

  it("degrades to no reason when the horizon read fails", async () => {
    settings.loadBookingHorizonDays.mockRejectedValue(new Error("booking_settings is gone"));
    cache.getBucketSlotsWithFallback.mockResolvedValue(emptyResult);
    const res = await get("411");

    expect(res.status).toBe(200);
    expect((await res.json()).emptyBecause).toBeNull();
  });
});


// #2158 -----------------------------------------------------------------------

describe("GET /api/availability, a bucket with nobody in it (#2158)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hours.loadBusinessHoursCached.mockResolvedValue({
      zone: "America/New_York",
      rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 })),
      exceptions: [],
      source: "stored" as const,
    });
    settings.loadBookingHorizonDays.mockResolvedValue(4);
    eligible.eligibleAgentIdsCached.mockResolvedValue({
      ids: [],
      fallbackApplied: false,
    });
  });

  /** An empty result on a real, open bucket. */
  function emptyRealBucket(isTest = false) {
    return { ...slotsFor(isTest), slots: [], bucket: { code: "120", is_test: isTest } };
  }

  it("tells the booker the bucket is unstaffed, not that it is busy", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(emptyRealBucket());
    const body = await (await get("120")).json();
    expect(body.emptyBecause).toEqual({ kind: "unstaffed" });
  });

  it("sends one throttled notice, keyed to the bucket, saying somebody actually arrived", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(emptyRealBucket());
    await get("120");

    const call = sendThrottledAlert.mock.calls.find(([key]) =>
      typeof key === "string" && key.startsWith("booker_unstaffed:"),
    );
    expect(call).toBeDefined();
    expect(call![0]).toBe("booker_unstaffed:120");
    expect(typeof call![1]).toBe("number");
    expect(String(call![2])).toContain("nobody to route to");
  });

  it("says nothing for the SMOKE fixtures, which are staffed on purpose and watched by the canary", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(emptyRealBucket(true));
    await get("120", "Bearer smoke-key");

    const calls = sendThrottledAlert.mock.calls.filter(([key]) =>
      typeof key === "string" && key.startsWith("booker_unstaffed:"),
    );
    expect(calls).toHaveLength(0);
  });

  it("says nothing, and claims nothing, when the pool count could not be read", async () => {
    // A failed read is not an empty pool. Reporting it as one would tell every
    // lead nobody works here on the strength of a query that never ran, and would
    // page about it too.
    eligible.eligibleAgentIdsCached.mockRejectedValue(new Error("supabase down"));
    cache.getBucketSlotsWithFallback.mockResolvedValue(emptyRealBucket());

    const res = await get("120");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.emptyBecause).toEqual({ kind: "busy" });
    expect(
      sendThrottledAlert.mock.calls.filter(([k]) => String(k).startsWith("booker_unstaffed:")),
    ).toHaveLength(0);
  });

  it("says nothing when the bucket has people in it and is merely full", async () => {
    eligible.eligibleAgentIdsCached.mockResolvedValue({
      ids: ["u1"],
      fallbackApplied: false,
    });
    cache.getBucketSlotsWithFallback.mockResolvedValue(emptyRealBucket());

    const body = await (await get("120")).json();
    expect(body.emptyBecause).toEqual({ kind: "busy" });
    expect(
      sendThrottledAlert.mock.calls.filter(([k]) => String(k).startsWith("booker_unstaffed:")),
    ).toHaveLength(0);
  });

  it("does not count the pool at all when there are times to offer", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    await get("SMOKE");
    // The ordinary hot path must pay nothing for this.
    expect(eligible.eligibleAgentIdsCached).not.toHaveBeenCalled();
  });
});

describe("GET /api/availability?advisor= (#2073)", () => {
  beforeEach(() => vi.clearAllMocks());
  const TOKEN = "ab".repeat(32);

  it("serves the named agent's times from the agent link, never the pooled cache", async () => {
    agentLink.agentLinkAvailabilityLive.mockResolvedValue({
      status: 200,
      body: { bucket: { code: "" }, orgName: "Pennie", eventType: { name: "Call", description: null, durationMin: 30 }, slots: ["2099-01-01T15:00:00.000Z"], emptyBecause: null },
    });
    const res = await GET(new NextRequest(`http://localhost/api/availability?advisor=${TOKEN}&from=2099-01-01T00:00:00.000Z&to=2099-01-05T00:00:00.000Z`));
    expect(res.status).toBe(200);
    expect((await res.json()).slots).toHaveLength(1);
    expect(agentLink.agentLinkAvailabilityLive).toHaveBeenCalledWith(
      TOKEN,
      { from: "2099-01-01T00:00:00.000Z", to: "2099-01-05T00:00:00.000Z" },
      expect.any(Number),
    );
    expect(cache.getBucketSlotsWithFallback).not.toHaveBeenCalled();
  });

  it("answers the refusal with its own status and body", async () => {
    agentLink.agentLinkAvailabilityLive.mockResolvedValue({
      status: 404,
      body: { error: "This advisor is not taking bookings through this link right now.", code: "AGENT_LINK_UNAVAILABLE" },
    });
    const res = await GET(new NextRequest(`http://localhost/api/availability?advisor=${TOKEN}`));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("AGENT_LINK_UNAVAILABLE");
  });

  it("is rate limited like every public availability read", async () => {
    rateLimit.availabilityWithinLimit.mockResolvedValueOnce(false);
    const res = await GET(new NextRequest(`http://localhost/api/availability?advisor=${TOKEN}`));
    expect(res.status).toBe(429);
    expect(agentLink.agentLinkAvailabilityLive).not.toHaveBeenCalled();
  });

  it("a fault in the agent link compute is an internal error, never an empty week", async () => {
    agentLink.agentLinkAvailabilityLive.mockRejectedValue(new Error("db down"));
    const res = await GET(new NextRequest(`http://localhost/api/availability?advisor=${TOKEN}`));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/availability?booking= (#2827)", () => {
  beforeEach(() => vi.clearAllMocks());
  const MANAGE = "cd".repeat(32);

  it("serves an advisor link booking's move times keyed on its manage token, never the pooled cache", async () => {
    rescheduleTimes.bookingRescheduleTimesLive.mockResolvedValue({
      status: 200,
      body: { bucket: { code: "" }, orgName: "Pennie", eventType: { name: "Call", description: null, durationMin: 30 }, slots: ["2099-01-01T15:00:00.000Z"], emptyBecause: null },
    });
    const res = await GET(new NextRequest(`http://localhost/api/availability?booking=${MANAGE}&from=2099-01-01T00:00:00.000Z`));
    expect(res.status).toBe(200);
    expect((await res.json()).slots).toEqual(["2099-01-01T15:00:00.000Z"]);
    expect(rescheduleTimes.bookingRescheduleTimesLive).toHaveBeenCalledWith(
      { manageToken: MANAGE },
      { from: "2099-01-01T00:00:00.000Z", to: null },
      expect.any(Number),
    );
    expect(cache.getBucketSlotsWithFallback).not.toHaveBeenCalled();
    expect(agentLink.agentLinkAvailabilityLive).not.toHaveBeenCalled();
  });

  it("answers the refusal with its own status and body", async () => {
    rescheduleTimes.bookingRescheduleTimesLive.mockResolvedValue({
      status: 404,
      body: { error: "We cannot offer new times for this call right now.", code: "RESCHEDULE_TIMES_UNAVAILABLE" },
    });
    const res = await GET(new NextRequest(`http://localhost/api/availability?booking=${MANAGE}`));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("RESCHEDULE_TIMES_UNAVAILABLE");
  });

  it("is rate limited like every public availability read", async () => {
    rateLimit.availabilityWithinLimit.mockResolvedValueOnce(false);
    const res = await GET(new NextRequest(`http://localhost/api/availability?booking=${MANAGE}`));
    expect(res.status).toBe(429);
    expect(rescheduleTimes.bookingRescheduleTimesLive).not.toHaveBeenCalled();
  });

  it("a fault reading the booking is an internal error, never an empty week", async () => {
    rescheduleTimes.bookingRescheduleTimesLive.mockRejectedValue(new Error("db down"));
    const res = await GET(new NextRequest(`http://localhost/api/availability?booking=${MANAGE}`));
    expect(res.status).toBe(500);
  });
});

// #2841: every tier the lead's cascade may use was full for three open days, so
// the fourth was opened. Sales ops want to be told (Dan, 2026-09-28: "if this
// happens, something is probably wrong, so I would set up an alert so that we
// could look at it").
describe("GET /api/availability: the fourth day was opened", () => {
  const extended = (isTest = false) => ({
    ...slotsFor(isTest),
    bucket: { code: "511", is_test: isTest },
    routing: { ...slotsFor(isTest).routing, requested_code: "511", effective_code: "511", window_extended: true },
  });
  beforeEach(() => sendThrottledAlert.mockClear());
  const windowAlerts = () =>
    sendThrottledAlert.mock.calls.filter(([key]) => String(key).startsWith("booking_window_extended:"));

  it("sends one throttled alert keyed to the bucket the lead asked for, and still serves the times", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(extended());
    const res = await get("511");

    expect(res.status).toBe(200);
    expect((await res.json()).slots).toEqual(["2099-01-01T15:00:00.000Z"]);
    const calls = windowAlerts();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("booking_window_extended:511");
    expect(typeof calls[0][1]).toBe("number");
    expect(String(calls[0][2])).toContain("511");
  });

  it("says nothing when the times were inside the window", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    await get("SMOKE");
    expect(windowAlerts()).toHaveLength(0);
  });

  it("says nothing for a test bucket", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(extended(true));
    await get("511", "Bearer smoke-key");
    expect(windowAlerts()).toHaveLength(0);
  });

  it("still serves the times when the alert itself fails", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(extended());
    sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    const res = await get("511");
    expect(res.status).toBe(200);
  });
});

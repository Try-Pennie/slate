import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
// always echo the REQUESTED code, even when the effective tier differs. The one
// routing fact it carries is `shownTier` (#3495), which the booker hands back
// with its confirm and never renders: Dan, 2026-10-07, "I don't want the lead to
// see it. I don't care if it's in the background in a spot they'll never see".

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
// #3775: the line a lead's confirm will join is woken while they read availability.
// The waker's decisions are pinned by scripts/test-confirm-line-wake.ts; this proves the
// route asks for the right code, and only for a bucket it served.
const lineWake = vi.hoisted(() => ({ wakeConfirmLineForCode: vi.fn() }));
vi.mock("@/lib/booking/confirm-line-live", () => lineWake);
// #4390: a program lead's times. The rules are pinned by scripts/test-program-lead-times.ts
// and the live reads by program-lead-times-live.test.ts; this proves the ROUTE hands the
// token from its header, the zone and the real slots to them, serves what they answer,
// and never asks them for an ordinary lead.
const programTimes = vi.hoisted(() => ({
  programLeadTimesLive: vi.fn(async (input: { realSlots: string[] }) => ({
    slots: input.realSlots,
    placeholderStarts: [] as string[],
    outcome: "program" as string,
  })),
}));
vi.mock("@/lib/booking/program-lead-times-live", () => programTimes);

import { NextRequest } from "next/server";
import { GENERIC_ERROR_MESSAGE } from "@/lib/api/errors";
import { HIDDEN_TEST_BUCKET_CODES, PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
import { TEST_PASS_HEADER, TEST_PASS_REFUSAL_CODES } from "@/lib/embed/test-pass-header";
import { TEST_PASS_TTL_MS, mintTestPass } from "@/lib/embed/test-pass";
import { PROGRAM_LEAD_HEADER } from "@/lib/booking/program-lead-header";
import { log } from "@/lib/log";
import type { SpanTimer } from "@/lib/api/server-timing";
import { GET } from "./route";

const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];

// #3713: the slot read is handed the request's own clock and its timer, so the parts of
// the read are timed on the same request's Server-Timing.
const READ_TIMING = [expect.any(Number), expect.anything()] as const;

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
      offered_open_days: 3,
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

describe("GET /api/availability wakes the lead's confirm line (#3775)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("wakes the line for the code it served, so the object is back before the confirm", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    const res = await get("411");
    expect(res.status).toBe(200);
    expect(lineWake.wakeConfirmLineForCode).toHaveBeenCalledTimes(1);
    expect(lineWake.wakeConfirmLineForCode).toHaveBeenCalledWith("411");
  });

  it("wakes nothing for a code it did not serve", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(null);
    const res = await get("999");
    expect(res.status).toBe(404);
    expect(lineWake.wakeConfirmLineForCode).not.toHaveBeenCalled();
  });
});

describe("GET /api/availability test-bucket hiding (#396)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards authorizedForTest=false and 404s when an unauthenticated lead is hidden a test bucket", async () => {
    // The hide lives in getBucketSlotsWithFallback: unauthorized → null → 404.
    cache.getBucketSlotsWithFallback.mockResolvedValue(null);
    const res = await get("SMOKE");
    expect(res.status).toBe(404);
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith("SMOKE", expect.any(String), false, ...READ_TIMING);
  });

  it("forwards authorizedForTest=false when the bearer key is wrong", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(null);
    const res = await get("SMOKE", "Bearer not-the-key");
    expect(res.status).toBe(404);
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith("SMOKE", expect.any(String), false, ...READ_TIMING);
  });

  it("serves a test bucket's slots to the key-authed smoke test", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(true));
    const res = await get("SMOKE", "Bearer smoke-key");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slots).toHaveLength(1);
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith("SMOKE", expect.any(String), true, ...READ_TIMING);
  });

  it("hides a test bucket from a partner's key (#2854)", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(null);
    const res = await get("SMOKE", "Bearer regal-key");
    expect(res.status).toBe(404);
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith("SMOKE", expect.any(String), false, ...READ_TIMING);
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
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith(PUBLIC_TEST, expect.any(String), true, ...READ_TIMING);
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
      ...READ_TIMING,
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
    expect(cache.getBucketSlotsWithFallback).toHaveBeenCalledWith(`${PUBLIC_TEST}2`, expect.any(String), false, ...READ_TIMING);
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
    // #3495: the tier whose times are on show, for the booker to hand back; the
    // effective code itself still appears nowhere.
    expect(body.shownTier).toBe("low");
    expect(JSON.stringify(body)).not.toContain("LOW411");
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

  it("hands a readable name to the same resolver an old token goes to (#3026)", async () => {
    agentLink.agentLinkAvailabilityLive.mockResolvedValue({
      status: 200,
      body: { bucket: { code: "" }, orgName: "Pennie", eventType: { name: "Call", description: null, durationMin: 30 }, slots: [], emptyBecause: null },
    });
    const res = await GET(new NextRequest("http://localhost/api/availability?advisor=rdaboub"));
    expect(res.status).toBe(200);
    expect(agentLink.agentLinkAvailabilityLive).toHaveBeenCalledWith("rdaboub", { from: null, to: null }, expect.any(Number));
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

// #2841: every tier the lead's cascade may use was full for the offered open days
// (the stored setting, #3922; 4 in this fixture), so a later day was opened.
// Sales ops want to be told (Dan, 2026-09-28: "if this happens, something is
// probably wrong, so I would set up an alert so that we could look at it").
describe("GET /api/availability: a day past the offered window was opened", () => {
  const extended = (isTest = false) => ({
    ...slotsFor(isTest),
    bucket: { code: "511", is_test: isTest },
    routing: { ...slotsFor(isTest).routing, requested_code: "511", effective_code: "511", window_extended: true, offered_open_days: 4 },
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
    // #3922: the number the lead was given, as the request read the stored setting.
    expect(String(calls[0][2])).toContain("next 4 open days");
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

// #3366: on 2026-10-06 leads were re-offered times that had been full for hours,
// and nothing said which layer served them. Every pooled read now logs which tier
// answered (`x-slot-cache`), how old the slots are, the UTC day the caller's `from`
// anchors to (an evening US lead's is yesterday's) and the colo, so the next
// occurrence names its layer instead of being reconstructed.
describe("GET /api/availability names the layer that served it (#3366)", () => {
  beforeEach(() => vi.clearAllMocks());
  const servedLine = () =>
    vi.mocked(log.info).mock.calls.find(([tag, fields]) => tag === "availability" && fields.msg === "slots served");

  it("logs the tier, the freshness stamp, the from anchor and the colo", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue({ ...slotsFor(false), source: "hit" });
    const headers = new Headers({ "cf-ray": "a46585f9ef25e56c-DEN" });
    const res = await GET(
      new NextRequest("http://localhost/api/availability?bucket=411&from=2026-10-05T07%3A00%3A00.000Z", { headers }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-slot-cache")).toBe("hit");
    expect(servedLine()?.[1]).toMatchObject({
      bucket: "411",
      slot_cache: "hit",
      computed_at: "2026-07-20T12:00:00.000Z",
      from_anchor: "2026-10-05",
      colo: "DEN",
      slots: 1,
    });
  });

  it("says the row tier and today's anchor when no from is sent", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue({ ...slotsFor(false), source: "row" });
    const res = await get("411");
    expect(res.status).toBe(200);
    expect(servedLine()?.[1]).toMatchObject({ slot_cache: "miss", from_anchor: new Date().toISOString().slice(0, 10) });
    // No cf-ray and no Cloudflare context: unknown, never a guessed colo.
    expect(servedLine()?.[1].colo ?? null).toBeNull();
  });

  it("logs an unreadable from as unreadable rather than throwing", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    const res = await GET(new NextRequest("http://localhost/api/availability?bucket=411&from=not-a-date"));
    expect(res.status).toBe(200);
    expect(servedLine()?.[1]).toMatchObject({ from_anchor: "unreadable" });
  });

  // #2220: an unreadable `to` filters nothing, so the line is where it is seen.
  it("logs an unreadable to as unreadable, and says nothing of a readable one", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    await GET(new NextRequest("http://localhost/api/availability?bucket=411&to=not-a-date"));
    expect(servedLine()?.[1]).toMatchObject({ to_anchor: "unreadable" });
    vi.mocked(log.info).mockClear();
    await GET(new NextRequest("http://localhost/api/availability?bucket=411&to=2099-02-01T00%3A00%3A00.000Z"));
    expect(servedLine()?.[1]).not.toHaveProperty("to_anchor");
  });

  it("logs nothing about a bucket it could not find", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(null);
    await get("NOPE");
    expect(servedLine()).toBeUndefined();
  });

  // #3381: on 2026-10-14 a stored row offered a time nobody was free for, two minutes
  // after it was computed, and two writers had run that second. The line names which
  // one wrote what was served, and whether a booking was spliced in since.
  it("names the path that wrote what it served, and any splice since", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue({
      ...slotsFor(false),
      source: "row",
      writtenBy: "lane",
      spliced: "2026-10-14T08:45:10.000Z+reoffer",
    });
    await get("411");
    expect(servedLine()?.[1]).toMatchObject({ written_by: "lane", spliced: "2026-10-14T08:45:10.000Z+reoffer" });
  });

  it("says not recorded, never a guess, when the entry carries no writer", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    await get("411");
    expect(servedLine()?.[1]).toMatchObject({ written_by: null, spliced: null });
  });
});

// #3653 / #3652: the canary could time a read and could not say where the time went,
// so a slow cached read on 2026-10-12 could not be told from a slow network. The pooled
// read now carries a Server-Timing with the Worker's own elapsed time, the burst limiter
// and the slot read, and since #3713 the slot read's own parts. The clock is faked (Date
// only) and moved by the mocks, so the durations are exact and nothing waits.
describe("GET /api/availability reports its own time (#3653)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T03:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  const tick = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it("names the limiter, the slot read and the Worker total", async () => {
    rateLimit.availabilityWithinLimit.mockImplementationOnce(async () => {
      tick(40);
      return true;
    });
    cache.getBucketSlotsWithFallback.mockImplementationOnce(async () => {
      tick(12);
      return slotsFor(false);
    });
    const res = await get("411");
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toBe("limit;dur=40, slots;dur=12, worker;dur=52");
    // The same total in the served line, so the Worker logs can answer #3652 too.
    const served = vi
      .mocked(log.info)
      .mock.calls.find(([tag, fields]) => tag === "availability" && fields.msg === "slots served");
    expect(served?.[1]).toMatchObject({ worker_ms: 52 });
  });

  it("does not change what is served or how it is cached", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    const res = await get("411");
    expect(res.headers.get("x-slot-cache")).toBe("hit");
    expect(res.headers.get("cache-control")).toBeNull();
    const body = await res.json();
    expect(body.slots).toEqual(["2099-01-01T15:00:00.000Z"]);
  });

  it("adds nothing to the 404, so an unknown and a hidden bucket still answer alike (#601)", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(null);
    const res = await get("NOPE");
    expect(res.status).toBe(404);
    expect(res.headers.get("server-timing")).toBeNull();
  });

  // #3713: evening lead reads spend about half a second in the Worker on cached times,
  // and one `slots` span could not say which read inside it waited, nor whether the
  // isolate was fresh. The slot read now records its parts on the timer the route
  // hands it, and the served line carries each part and the isolate's facts.
  it("splits the slot read into its parts, in the header and on the served line", async () => {
    rateLimit.availabilityWithinLimit.mockImplementationOnce(async () => {
      tick(5);
      return true;
    });
    cache.getBucketSlotsWithFallback.mockImplementationOnce(
      async (_code: string, _from: string, _test: boolean, _now: number, timer: SpanTimer) => {
        await timer.span("cache", async () => tick(3));
        await timer.span("hours", async () => tick(280));
        await timer.span("hours", async () => tick(0));
        return slotsFor(false);
      },
    );
    const res = await get("411");
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toBe(
      "limit;dur=5, cache;dur=3, hours;dur=280, slots;dur=283, worker;dur=288",
    );
    const fields = servedFields();
    expect(fields).toMatchObject({ limit_ms: 5, slots_ms: 283, cache_ms: 3, hours_ms: 280, worker_ms: 288 });
    // A part that never ran is absent from the line, never a measured 0 (L90), and not
    // a null key either: the fields carry only the parts that ran.
    for (const absent of ["row_ms", "compute_ms", "fallback_ms"]) expect(fields).not.toHaveProperty(absent);
  });

  it("names the isolate's runs, its age and the route's own request count on the served line", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    const key = Symbol.for("slate.isolate-runs");
    const g = globalThis as unknown as Record<symbol, unknown>;
    const saved = g[key];
    try {
      // As the Worker records it: two earlier runs of the app, the first 90s ago, and
      // this read the third.
      g[key] = { runs: 3, firstRunAtMs: Date.now() - 90_000 };
      await get("411");
      const first = servedFields();
      expect(first).toMatchObject({ isolate_runs: 3, isolate_age_ms: 90_000 });
      const before = first?.route_requests as number;
      expect(before).toBeGreaterThanOrEqual(1);

      // A request that never reaches the pooled read still loaded and ran this module,
      // so it counts: otherwise a module first evaluated by a 404 or a 429 would read
      // as fresh on the next served read (lessons review on this change).
      cache.getBucketSlotsWithFallback.mockResolvedValueOnce(null);
      expect((await get("NOPE")).status).toBe(404);
      rateLimit.availabilityWithinLimit.mockResolvedValueOnce(false);
      expect((await get("411")).status).toBe(429);

      vi.mocked(log.info).mockClear();
      await get("411");
      expect(servedFields()?.route_requests).toBe(before + 3);
    } finally {
      g[key] = saved;
    }
  });

  it("leaves the isolate's facts off the line when no Worker recorded them, never a guessed fresh isolate", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue(slotsFor(false));
    const key = Symbol.for("slate.isolate-runs");
    const g = globalThis as unknown as Record<symbol, unknown>;
    const saved = g[key];
    try {
      delete g[key];
      await get("411");
      const fields = servedFields();
      expect(fields).not.toHaveProperty("isolate_runs");
      expect(fields).not.toHaveProperty("isolate_age_ms");
      expect(typeof fields?.route_requests).toBe("number");
    } finally {
      g[key] = saved;
    }
  });

  const servedFields = () =>
    vi.mocked(log.info).mock.calls.find(([tag, fields]) => tag === "availability" && fields.msg === "slots served")?.[1];
});

// #2220 (Dan, 2026-10-16): a window past what is offered answers EMPTY and says why,
// never with the times of another window. `from` used to reach only the cache read,
// which answers with the stored horizon wherever it is asked, so a request for a week
// in November came back 200 with September's times and `emptyBecause: null`. Every
// served time now lies inside the asked window, and an empty answer whose offered
// times all fall before `from` says `beyond_horizon` with the last time offered.
describe("GET /api/availability answers the window it was asked about (#2220)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // An open week, set here rather than inherited: an earlier case leaves the mock
    // on a week with no open day, which would read every empty answer as closed.
    hours.loadBusinessHoursCached.mockResolvedValue({
      zone: "America/New_York",
      rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 })),
      exceptions: [],
      source: "stored" as const,
    });
    // and a staffed pool with the ordinary horizon, for the same reason.
    settings.loadBookingHorizonDays.mockResolvedValue(4);
    eligible.eligibleAgentIdsCached.mockResolvedValue({ ids: ["u1", "u2"], fallbackApplied: false });
  });
  const OFFERED = ["2099-01-01T15:00:00.000Z", "2099-01-02T15:00:00.000Z", "2099-01-03T15:00:00.000Z"];
  const offering = (slots: string[]) => cache.getBucketSlotsWithFallback.mockResolvedValue({ ...slotsFor(false), slots });
  const ask = (query: string) => GET(new NextRequest(`http://localhost/api/availability?bucket=411&${query}`));

  it("serves only the times inside the asked window, never times before `from`", async () => {
    offering(OFFERED);
    const body = await (await ask("from=2099-01-02T00:00:00.000Z&to=2099-01-02T23:59:00.000Z")).json();
    expect(body.slots).toEqual(["2099-01-02T15:00:00.000Z"]);
    expect(body.emptyBecause).toBeNull();
  });

  it("answers a window wholly past the offered times with nothing, and names the last time offered", async () => {
    offering(OFFERED);
    const res = await ask("from=2099-02-01T00:00:00.000Z&to=2099-02-07T00:00:00.000Z");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slots).toEqual([]);
    expect(body.emptyBecause).toEqual({ kind: "beyond_horizon", lastOfferedAt: "2099-01-03T15:00:00.000Z" });
    // The window is not empty because the org is shut or full, so neither is asked.
    expect(hours.loadBusinessHoursCached).not.toHaveBeenCalled();
  });

  it("trims a window that starts inside what is offered and runs past it to the times offered", async () => {
    offering(OFFERED);
    const body = await (await ask("from=2099-01-02T00:00:00.000Z&to=2099-03-01T00:00:00.000Z")).json();
    expect(body.slots).toEqual(["2099-01-02T15:00:00.000Z", "2099-01-03T15:00:00.000Z"]);
    expect(body.emptyBecause).toBeNull();
  });

  it("explains a window as it always did when nothing at all is offered, wherever it is asked", async () => {
    offering([]);
    const body = await (await ask("from=2099-02-01T00:00:00.000Z")).json();
    expect(body.emptyBecause).toEqual({ kind: "busy" });
  });

  it("explains an empty window inside what is offered as it always did, not as beyond the horizon", async () => {
    offering(OFFERED);
    // Between the second and third offered times: inside, just empty.
    const body = await (await ask("from=2099-01-02T16:00:00.000Z&to=2099-01-03T14:00:00.000Z")).json();
    expect(body.slots).toEqual([]);
    expect(body.emptyBecause).toEqual({ kind: "busy" });
  });

  it("does not filter on an unreadable `from` or `to`, rather than dropping every time and calling the bucket busy", async () => {
    offering(OFFERED);
    for (const query of ["from=not-a-date", "to=not-a-date"]) {
      const body = await (await ask(query)).json();
      expect(body.slots).toEqual(OFFERED);
      expect(body.emptyBecause).toBeNull();
    }
  });
});

describe("GET /api/availability for a program lead (#4390)", () => {
  const TOKEN = "00Q5f00000AbCdE.new.9999999999999.abc";
  const REAL = "2099-01-01T15:00:00.000Z";
  const EXTRA = "2099-01-01T16:00:00.000Z";

  beforeEach(() => {
    vi.clearAllMocks();
    hours.loadBusinessHoursCached.mockResolvedValue({
      zone: "America/New_York",
      rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 })),
      exceptions: [],
      source: "stored" as const,
    });
    settings.loadBookingHorizonDays.mockResolvedValue(4);
    eligible.eligibleAgentIdsCached.mockResolvedValue({ ids: ["u1"], fallbackApplied: false });
    cache.getBucketSlotsWithFallback.mockResolvedValue({ ...slotsFor(false), bucket: { code: "411", is_test: false }, slots: [REAL] });
  });

  function program(query = "", token: string | null = TOKEN) {
    const headers = new Headers();
    if (token) headers.set(PROGRAM_LEAD_HEADER, token);
    return GET(new NextRequest(`http://localhost/api/availability?bucket=411${query}`, { headers }));
  }

  it("never asks for an ordinary lead, whose answer is unchanged", async () => {
    const body = await (await program("", null)).json();
    expect(programTimes.programLeadTimesLive).not.toHaveBeenCalled();
    expect(body.slots).toEqual([REAL]);
    expect(body).not.toHaveProperty("placeholderStarts");
  });

  it("hands the header's token, the zone and the real slots over, and serves the merged times", async () => {
    programTimes.programLeadTimesLive.mockResolvedValueOnce({ slots: [REAL, EXTRA], placeholderStarts: [EXTRA], outcome: "program" });
    const body = await (await program("&leadZone=America%2FChicago")).json();
    expect(programTimes.programLeadTimesLive).toHaveBeenCalledWith({
      token: TOKEN,
      leadZone: "America/Chicago",
      realSlots: [REAL],
      eventType: expect.objectContaining({ duration_min: 30, min_notice_min: 0 }),
    });
    expect(body.slots).toEqual([REAL, EXTRA]);
    expect(body.placeholderStarts).toEqual([EXTRA]);
  });

  it("applies the asked window to the placeholder's starts too", async () => {
    programTimes.programLeadTimesLive.mockResolvedValueOnce({ slots: [REAL, EXTRA], placeholderStarts: [EXTRA], outcome: "program" });
    const body = await (await program(`&to=${encodeURIComponent("2099-01-01T15:30:00.000Z")}`)).json();
    expect(body.slots).toEqual([REAL]);
    expect(body.placeholderStarts).toEqual([]);
  });

  it("offers the extra times with no empty reason when no real advisor is free, and still raises an unstaffed pool", async () => {
    cache.getBucketSlotsWithFallback.mockResolvedValue({ ...slotsFor(false), bucket: { code: "411", is_test: false }, slots: [] });
    eligible.eligibleAgentIdsCached.mockResolvedValue({ ids: [], fallbackApplied: false });
    programTimes.programLeadTimesLive.mockResolvedValueOnce({ slots: [EXTRA], placeholderStarts: [EXTRA], outcome: "program" });
    const body = await (await program()).json();
    expect(body.slots).toEqual([EXTRA]);
    expect(body.emptyBecause).toBeNull();
    expect(sendThrottledAlert.mock.calls.some(([k]) => String(k) === "booker_unstaffed:411")).toBe(true);
  });

  it("logs how the read went and never the token", async () => {
    programTimes.programLeadTimesLive.mockResolvedValueOnce({ slots: [REAL], placeholderStarts: [], outcome: "fallback:counts-unreadable" });
    await program();
    const logged = JSON.stringify(vi.mocked(log.info).mock.calls);
    expect(logged).toContain("fallback:counts-unreadable");
    expect(logged).not.toContain(TOKEN);
  });
});

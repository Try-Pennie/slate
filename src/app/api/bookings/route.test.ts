import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// The pure half, deliberately NOT mocked: the route's key shape is what these assert on.
import { rateLimitKey, BOOKING_API_IP_LIMITER, type CallerKey } from "@/lib/rate-limit-core";

// HTTP-level wiring for the direct booking API skeleton (#355): the route maps
// the pure auth verdict to 503 (unconfigured) / 401 (bad key), trips 429 when
// the per-key ceiling is exceeded, and otherwise returns 501 until the booking
// body lands. Auth/key logic itself is covered by scripts/test-booking-api-auth.ts;
// the rate-limit IO and env reads are mocked so this exercises only the glue.

// #2865: the key these tests authenticate with is Regal's. There is no shared caller.
const regalKey = vi.hoisted(() => ({ primary: vi.fn(() => ""), secondary: vi.fn(() => "") }));
const env = vi.hoisted(() => ({
  bookingApiKeyFor: vi.fn((caller: string, slot: string) =>
    caller !== "regal" ? "" : slot === "primary" ? regalKey.primary() : regalKey.secondary(),
  ),
}));
const regalKeyFor = (caller: string, slot: string) =>
  caller !== "regal" ? "" : slot === "primary" ? regalKey.primary() : regalKey.secondary();
const rateLimit = vi.hoisted(() => ({
  allowRequest: vi.fn(async (_caller: unknown, _rules: unknown) => true),
  // Per-minute burst windows run at the edge (#961); default to allow so the auth /
  // outcome glue under test isn't throttled, and flip them per-test to exercise 429s.
  bookingApiWriteWithinLimit: vi.fn(async (_keyId: string) => true),
  bookingApiReadWithinLimit: vi.fn(async (_keyId: string) => true),
  bookingApiIpWithinLimit: vi.fn(async (_ip: string) => true),
  bearerFailureWithinLimit: vi.fn(async (_ip: string) => true),
  // Real derivation, not a stub: the per-IP ceiling (#597) is only as good as the IP it
  // keys on, and a faked clientIp would let a broken header order pass unnoticed.
  clientIp: (headers: Headers) =>
    headers.get("cf-connecting-ip")?.trim() ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown",
}));
const service = vi.hoisted(() => {
  class SlotUnavailableError extends Error {}
  // #2838: refused after a lost overlap race, a SlotUnavailableError underneath.
  class RaceLostRefusalError extends SlotUnavailableError {
    lostRaces: number;
    boundHit: boolean;
    constructor(lostRaces: number, boundHit: boolean) {
      super("taken");
      this.lostRaces = lostRaces;
      this.boundHit = boundHit;
    }
  }
  class VerifyUnavailableError extends Error {}
  class NoEligibleAgentsError extends Error {}
  class UnknownBucketError extends Error {}
  class OutsideCallingWindowError extends Error {}
  return {
    OutsideCallingWindowError,
    bookViaApi: vi.fn(),
    previewBooking: vi.fn(),
    listBookings: vi.fn(),
    getPersonBookingById: vi.fn(),
    lookupPersonBookings: vi.fn(),
    bookingDetailExtras: vi.fn(),
    SlotUnavailableError,
    RaceLostRefusalError,
    VerifyUnavailableError,
    NoEligibleAgentsError,
    UnknownBucketError,
  };
});

const monitor = vi.hoisted(() => ({ recordApiOutcome: vi.fn() }));
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/booking/service", () => service);
// The daily outcome tally (#418) is asserted directly: a declined bucket change
// has to be COUNTABLE, not merely reported in one response (L77).
vi.mock("@/lib/monitor/record-api-outcome", () => monitor);

import { POST, GET } from "./route";
import { deadlineWithinBudget } from "@/lib/call-budget";
import { BOOKING_CONFIRM_BUDGET_MS } from "@/lib/booking/confirm-budget";
import { PARTNER_KEYS } from "@/lib/booking/partner-keys";
import { HIDDEN_TEST_BUCKET_CODES, PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];
import {
  DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_READ_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
} from "@/lib/rate-limit-core";

function result(outcome: string, routingTrace: unknown = { bucket_code: "411" }) {
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
      // #1515: the booking's own trace records the bucket it actually LANDED in,
      // which is not the requested one after a tier drop or a cross bucket rebook.
      routing_trace: routingTrace,
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
    regalKey.primary.mockReturnValue("");
    regalKey.secondary.mockReturnValue("");
    rateLimit.allowRequest.mockClear();
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockClear();
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiReadWithinLimit.mockClear();
    rateLimit.bookingApiReadWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockClear();
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
    monitor.recordApiOutcome.mockClear();
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
    regalKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer wrong-secret");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the Authorization header is missing", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    const res = await post();
    expect(res.status).toBe(401);
  });

  it("authenticates the secondary key too (zero-downtime rotation)", async () => {
    regalKey.primary.mockReturnValue("old-secret");
    regalKey.secondary.mockReturnValue("new-secret");
    const res = await post("Bearer new-secret", VALID_BODY);
    expect(res.status).toBe(200);
  });

  it("trips 429 when the per-key ceiling is exceeded", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    rateLimit.allowRequest.mockResolvedValue(false);
    const res = await post("Bearer real-secret");
    expect(res.status).toBe(429);
  });

  it("rate-limits on the matched key's CALLER, in its own bucket (#2645)", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    await post("Bearer real-secret");
    expect(rateLimit.allowRequest).toHaveBeenCalledWith(
      { kind: "opaque", key: "key:regal" },
      DIRECT_BOOKING_API_HOURLY_RATE_RULES,
    );
    // The per-minute burst window runs at the edge (#961), keyed on the caller.
    expect(rateLimit.bookingApiWriteWithinLimit).toHaveBeenCalledWith("regal");
  });

  // #961: the per-minute window is the edge limiter now. A block there must 429
  // BEFORE the DB hourly cap is consulted (no wasted round-trip on a throttled call).
  it("trips 429 on the per-key EDGE limiter, without touching the DB hourly cap", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(false);
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(429);
    expect(rateLimit.allowRequest).not.toHaveBeenCalledWith(
      { kind: "opaque", key: "key:regal" },
      DIRECT_BOOKING_API_HOURLY_RATE_RULES,
    );
    expect(service.bookViaApi).not.toHaveBeenCalled();
  });

  // #597: per-key alone meant a leaked integrator key had a 6000/hr ceiling and no
  // second bound. The per-IP ceiling caps any single machine well below that.
  it("ALSO applies a per-IP ceiling, keyed on the client IP in a separate bucket", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    await post("Bearer real-secret", VALID_BODY, "203.0.113.9");
    expect(rateLimit.allowRequest).toHaveBeenCalledWith(
      // #1557: an address descriptor carrying the backstop's own answer for a caller it
      // cannot identify, not a bare key string.
      { kind: "address", ip: "203.0.113.9", keyPrefix: "ip:", policy: BOOKING_API_IP_LIMITER },
      DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
    );
    // The per-minute backstop runs at the edge (#961), keyed on the client IP.
    expect(rateLimit.bookingApiIpWithinLimit).toHaveBeenCalledWith("203.0.113.9");
  });

  it("trips 429 on the per-IP EDGE backstop even when the key is within budget", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(false);
    const res = await post("Bearer real-secret", VALID_BODY, "203.0.113.9");
    expect(res.status).toBe(429);
    expect(service.bookViaApi).not.toHaveBeenCalled();
  });

  it("trips 429 on the per-IP ceiling even when the key is well within its budget", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    // The key is fine; only the IP is flooding. This is the leaked-key case.
    rateLimit.allowRequest.mockImplementation(
      async (caller: unknown) => !rateLimitKey(caller as CallerKey).startsWith("ip:"),
    );

    const res = await post("Bearer real-secret", VALID_BODY, "203.0.113.9");

    expect(res.status).toBe(429);
    expect(service.bookViaApi).not.toHaveBeenCalled();
  });

  it("returns 400 for an authenticated call with an invalid body", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    const { externalId: _drop, ...noExternalId } = VALID_BODY;
    const res = await post("Bearer real-secret", noExternalId);
    expect(res.status).toBe(400);
  });

  it("surfaces attendee field errors on a bad-contact body", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret", {
      ...VALID_BODY,
      attendee: { name: "Dana", email: "", phone: "2155550100" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ fieldErrors: { email: expect.any(String) } });
  });

  it("routes a dryRun call to previewBooking and returns the preview (no booking)", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret", { ...VALID_BODY, dryRun: true });
    expect(res.status).toBe(200);
    expect(service.previewBooking).toHaveBeenCalledOnce();
    expect(service.bookViaApi).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ dryRun: true, outcome: "created", wouldAssign: { email: "a@x.com" } });
  });

  it("answers a dry run outside the calling window with the same code a real call gets (#2310)", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    service.previewBooking.mockRejectedValueOnce(new service.OutsideCallingWindowError("outside"));
    const res = await post("Bearer real-secret", { ...VALID_BODY, dryRun: true });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "OUTSIDE_CALLING_WINDOW" });
  });

  it("returns 200 with the booking on a created/deduped/rescheduled outcome", async () => {
    regalKey.primary.mockReturnValue("real-secret");
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

  it("hands the authenticated caller to the booking, so a call naming no page records who made it (#2876)", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(200);
    expect(service.bookViaApi).toHaveBeenCalledWith(expect.objectContaining({ apiCaller: "regal" }));
  });

  it("returns 409 on confirm_required so the bot can ask the lead first", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    service.bookViaApi.mockResolvedValue(result("confirm_required"));
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ outcome: "confirm_required" });
  });

  it("runs the API booking under the confirm budget (#3102)", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    let wait: number | null = null;
    service.bookViaApi.mockImplementationOnce(async () => {
      wait = deadlineWithinBudget(60_000, "probe").waitMs;
      return result("created");
    });
    await post("Bearer real-secret", VALID_BODY);
    expect(wait).not.toBeNull();
    expect(wait!).toBeLessThanOrEqual(BOOKING_CONFIRM_BUDGET_MS);
  });

  it("records a failed API booking under the cleanup allowance (#3102)", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    const labels: (string | undefined)[] = [];
    monitor.recordApiOutcome.mockImplementation(() => {
      labels.push(deadlineWithinBudget(60_000, "probe").reportAs.budget?.label);
    });
    service.bookViaApi.mockRejectedValueOnce(new service.VerifyUnavailableError("outage"));
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(503);
    expect(labels).toEqual(["the booking cleanup"]);
    monitor.recordApiOutcome.mockReset();
  });


  it("maps each booking error to a stable status + machine code", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    const cases: [Error, number, string][] = [
      [new service.UnknownBucketError("nope"), 422, "UNKNOWN_BUCKET"],
      [new service.NoEligibleAgentsError("empty"), 409, "NO_ELIGIBLE_AGENTS"],
      [new service.SlotUnavailableError("taken"), 409, "SLOT_TAKEN"],
      [new service.VerifyUnavailableError("outage"), 503, "VERIFY_UNAVAILABLE"],
      // #2310: a start outside the lead's calling window: pick another time.
      [new service.OutsideCallingWindowError("outside"), 422, "OUTSIDE_CALLING_WINDOW"],
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
    regalKey.primary.mockReturnValue("real-secret");
    const { externalId: _drop, ...noExternalId } = VALID_BODY;
    const res = await post("Bearer real-secret", noExternalId);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION" });
  });

  it("does NOT leak the raw message on an INTERNAL 500, but keeps the code (#707)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    regalKey.primary.mockReturnValue("real-secret");
    service.bookViaApi.mockRejectedValueOnce(new Error('relation "bookings" does not exist'));
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(body.error).not.toMatch(/bookings|does not exist/);
  });

  it("keeps the intended message on a typed error (SLOT_TAKEN) (#707)", async () => {
    regalKey.primary.mockReturnValue("real-secret");
    service.bookViaApi.mockRejectedValueOnce(new service.SlotUnavailableError("That time was just taken."));
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("SLOT_TAKEN");
    expect(body.error).toBe("That time was just taken.");
  });

  // #801: the key-attribution line is the audit trail for who called the booking
  // API. Cloudflare stores console.log WITHOUT a `level`, so a console.log audit
  // line is absent from every level-filtered query and cannot be read back in
  // practice. It must go out at a level-carrying method (console.info).
  it("emits the key-attribution audit line at a queryable level, never console.log", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    regalKey.primary.mockReturnValue("real-secret");

    await post("Bearer real-secret", VALID_BODY);

    // #808: every line is now `slate tag=<subsystem> ...`, so the audit trail is
    // found by filtering tag=booking-api rather than guessing at a substring.
    expect(info).toHaveBeenCalledWith(expect.stringContaining("tag=booking-api"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('msg="authenticated request"'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('key="regal:primary"'));
    expect(log).not.toHaveBeenCalled();
  });

  // The per-call outcome line (#375/#418) is the queryable signal for the bot's
  // outcome mix (confirm_required rate, cross-bucket moves, errors). It used to be
  // a bespoke prefix + JSON blob in its own module; #808 folded it into the one
  // tagged format, so the fields it carries are pinned here instead.
  it("emits the outcome line with the fields the bot's outcome mix is tallied from", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    regalKey.primary.mockReturnValue("real-secret");
    service.bookViaApi.mockResolvedValueOnce(result("confirm_required"));

    await post("Bearer real-secret", VALID_BODY);

    const outcome = info.mock.calls.map(String).find((l) => l.includes('msg="outcome"'));
    expect(outcome).toContain("tag=booking-api");
    expect(outcome).toContain('outcome="confirm_required"');
    expect(outcome).toContain('bucket="411"');
    expect(outcome).toContain('key="regal:primary"');
    expect(outcome).toContain("status=409");
  });

  it("carries the machine error code on the outcome line when the call fails", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    regalKey.primary.mockReturnValue("real-secret");
    service.bookViaApi.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));

    await post("Bearer real-secret", VALID_BODY);

    const outcome = info.mock.calls.map(String).find((l) => l.includes('msg="outcome"'));
    expect(outcome).toContain('outcome="error"');
    expect(outcome).toContain('code="SLOT_TAKEN"');
    expect(outcome).toContain("status=409");
  });

  // The failure path still has to be attributable: a call that errors out must
  // not lose its audit line, or a misbehaving bot becomes untraceable.
  it("still attributes the caller at a queryable level when the booking fails", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    regalKey.primary.mockReturnValue("real-secret");
    service.bookViaApi.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));

    const res = await post("Bearer real-secret", VALID_BODY);

    expect(res.status).toBe(409);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("tag=booking-api"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('msg="authenticated request"'));
    expect(log).not.toHaveBeenCalled();
  });
});

describe("GET /api/bookings (list mode + lookup mode)", () => {
  beforeEach(() => {
    regalKey.primary.mockReturnValue("real-secret");
    regalKey.secondary.mockReturnValue("");
    rateLimit.allowRequest.mockClear();
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockClear();
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiReadWithinLimit.mockClear();
    rateLimit.bookingApiReadWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockClear();
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
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

  // #1675: an unreadable page refuses retriably. A 200 with an empty list is the
  // answer "that is everything" to a caller that pages, so it would move its
  // watermark past bookings nobody read.
  it("GET list mode refuses with 503 when the page cannot be read", async () => {
    service.listBookings.mockRejectedValue(new Error("read failed [queryBookings rows]: statement timeout"));
    const res = await authedGet("http://localhost/api/bookings?status=confirmed");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("LIST_UNAVAILABLE");
    expect(body.bookings).toBeUndefined();
    // The refusal must not leak the underlying read error to the caller.
    expect(JSON.stringify(body)).not.toMatch(/statement timeout/);
  });

  // The control: a genuinely empty page is still a 200 empty page, so the
  // refusal above cannot be satisfied by a route that refuses everything.
  it("GET list mode returns 200 for a genuinely empty page", async () => {
    service.listBookings.mockResolvedValue({ items: [], nextCursor: null });
    const res = await authedGet("http://localhost/api/bookings?status=confirmed");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bookings: [], nextCursor: null });
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
    regalKey.primary.mockReturnValue("");
    const res = await GET(new Request("http://localhost/api/bookings") as never);
    expect([401, 503]).toContain(res.status);
  });

  it("GET (read) draws from the separate read rate ceiling, not the write one", async () => {
    await authedGet("http://localhost/api/bookings?status=confirmed");
    expect(rateLimit.allowRequest).toHaveBeenCalledWith(
      { kind: "opaque", key: "key:regal" },
      DIRECT_BOOKING_API_READ_HOURLY_RATE_RULES,
    );
    expect(rateLimit.allowRequest).not.toHaveBeenCalledWith(
      { kind: "opaque", key: "key:regal" },
      DIRECT_BOOKING_API_HOURLY_RATE_RULES,
    );
    // And its edge per-minute window is the READ binding, not the write one (#961).
    expect(rateLimit.bookingApiReadWithinLimit).toHaveBeenCalledWith("regal");
    expect(rateLimit.bookingApiWriteWithinLimit).not.toHaveBeenCalled();
  });
});

// #597: reads deliberately do NOT get the per-IP ceiling. It is sized for the write path
// (60/min), while status polling is cheap, bursty, and runs against a ~10x larger per-key
// budget (#393). Applying it here would throttle the integrator's legitimate polling from
// their single host. Pinned so a well-meaning "make it consistent" change cannot quietly
// start 429ing reads.
describe("GET rate limiting (#597)", () => {
  beforeEach(() => {
    regalKey.primary.mockReturnValue("real-secret");
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.allowRequest.mockClear();
    rateLimit.bookingApiWriteWithinLimit.mockClear();
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiReadWithinLimit.mockClear();
    rateLimit.bookingApiReadWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockClear();
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
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
      { kind: "opaque", key: "key:regal" },
      DIRECT_BOOKING_API_READ_HOURLY_RATE_RULES,
    );
    const keys = rateLimit.allowRequest.mock.calls.map(([c]) => rateLimitKey(c as CallerKey));
    expect(keys.every((k) => !String(k).startsWith("ip:"))).toBe(true);
    // Reads opt out of the per-IP edge backstop too, not just the DB one (#597/#961).
    expect(rateLimit.bookingApiIpWithinLimit).not.toHaveBeenCalled();
  });
});

describe("POST /api/bookings: a declined bucket change (#1465)", () => {

  // #1465: a same time rebook into a DIFFERENT bucket is honoured, and when it
  // cannot be, the response has to say so. A bare 200 deduped reads as "handled"
  // while the routing request was dropped and the lead stayed with the old team.
  it("names a declined bucket change on the response, with the bucket that was asked for", async () => {
    regalKey.primary.mockReturnValue("secret");
    service.bookViaApi.mockResolvedValue({
      ...result("deduped"),
      bucketChangeDeclined: "no_eligible_agents",
    });

    const res = await post("Bearer secret", VALID_BODY);
    const body = await res.json();

    expect(res.status).toBe(200); // the lead DOES hold a valid appointment
    expect(body.outcome).toBe("deduped");
    expect(body.bucketChangeDeclined).toEqual({
      requestedBucketCode: "411",
      reason: "no_eligible_agents",
    });
    // L77: countable, so one unlucky lead and a bucket refusing every move are
    // not the same number. An ordinary dedupe carries no code (asserted below),
    // so the two cannot share a row.
    expect(monitor.recordApiOutcome).toHaveBeenCalledWith(
      "deduped",
      "411",
      "bucket_change_declined_no_eligible_agents",
      // #1616: every recording site names how the test marker is resolved.
      { by: "bucket", code: "411", host: { prefill: {}, referrer_origin: null } },
    );
  });

  it("omits the field entirely when nothing was declined, so its presence always means something", async () => {
    regalKey.primary.mockReturnValue("secret");
    service.bookViaApi.mockResolvedValue(result("deduped"));

    const res = await post("Bearer secret", VALID_BODY);
    const body = await res.json();

    expect(body.outcome).toBe("deduped");
    expect("bucketChangeDeclined" in body).toBe(false);
    expect(monitor.recordApiOutcome).toHaveBeenCalledWith("deduped", "411", null, {
      by: "bucket",
      code: "411",
      host: { prefill: {}, referrer_origin: null },
    });
  });
});
// #2838: the direct API reaches the same race loop the booker does, so a lost race
// is counted here too, beside the ordinary outcome and outside the failure share.
describe("POST /api/bookings: lost overlap races are counted (#2838)", () => {
  beforeEach(() => {
    regalKey.primary.mockReturnValue("secret");
    monitor.recordApiOutcome.mockClear();
  });
  const outcomes = () => monitor.recordApiOutcome.mock.calls.map((c) => [c[0], c[2]]);

  it("counts a created booking that was handed on after a lost race", async () => {
    service.bookViaApi.mockResolvedValue({
      ...result("created", { bucket_code: "411", race_lost: ["a"] }),
      raceOutcome: "race_reassigned",
    });
    await post("Bearer secret", VALID_BODY);
    expect(outcomes()).toEqual([["created", null], ["race_reassigned", null]]);
  });

  it("counts only the race the service names, never one read off the booking's trace", async () => {
    // A same key replay still answers `created` and carries the earlier confirm's
    // trace. The service decides whether THIS call's insert made the booking
    // (scripts/test-booking-api.ts), so the route must not re-derive it.
    service.bookViaApi.mockResolvedValue(result("created", { bucket_code: "411", race_lost: ["a"] }));
    await post("Bearer secret", VALID_BODY);
    expect(outcomes()).toEqual([["created", null]]);
  });

  // #2861: the cross bucket move confirms through the same race loop, and used to
  // reach the tally in neither of its outcomes.
  // #2867: on its own row, since its outcome row is never `created`.
  it("counts a race rescued on a cross bucket move", async () => {
    service.bookViaApi.mockResolvedValue({
      ...result("rescheduled", { bucket_code: "411", race_lost: ["a"] }),
      raceOutcome: "race_reassigned_move",
    });
    const res = await post("Bearer secret", VALID_BODY);
    expect((await res.json()).outcome).toBe("rescheduled");
    expect(outcomes()).toEqual([["rescheduled", null], ["race_reassigned_move", null]]);
  });

  it("counts a race that refused a cross bucket move, beside the declined change", async () => {
    service.bookViaApi.mockResolvedValue({
      ...result("deduped"),
      bucketChangeDeclined: "slot_taken",
      raceOutcome: "race_refused_bound",
    });
    const res = await post("Bearer secret", VALID_BODY);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.outcome).toBe("deduped");
    expect(body.bucketChangeDeclined.reason).toBe("slot_taken");
    expect("raceOutcome" in body).toBe(false);
    expect(outcomes()).toEqual([
      ["deduped", "bucket_change_declined_slot_taken"],
      ["race_refused_bound", null],
    ]);
  });

  it("counts an uncontested booking once", async () => {
    service.bookViaApi.mockResolvedValue(result("created"));
    await post("Bearer secret", VALID_BODY);
    expect(outcomes()).toEqual([["created", null]]);
  });

  it("does not count a race on a booking this call did not make", async () => {
    // A dedupe names the booking the lead already held, whose trace describes an
    // earlier confirm: counting it again would count one race twice.
    service.bookViaApi.mockResolvedValue(result("deduped", { bucket_code: "411", race_lost: ["a"] }));
    await post("Bearer secret", VALID_BODY);
    expect(outcomes()).toEqual([["deduped", null]]);
  });

  it("counts a refusal after a lost race, and one at the bound, apart from SLOT_TAKEN", async () => {
    service.bookViaApi.mockRejectedValueOnce(new service.RaceLostRefusalError(1, false));
    expect((await post("Bearer secret", VALID_BODY)).status).toBe(409);
    service.bookViaApi.mockRejectedValueOnce(new service.RaceLostRefusalError(4, true));
    expect((await post("Bearer secret", VALID_BODY)).status).toBe(409);
    expect(outcomes()).toEqual([
      ["error", "SLOT_TAKEN"],
      ["race_refused", null],
      ["error", "SLOT_TAKEN"],
      ["race_refused_bound", null],
    ]);
  });
});

// #1515: the caller is the system of record for which team owns a lead, and the
// response named an agent and nothing else. Two things move a lead away from the
// bucket that was asked for, and neither was visible: a cross bucket rebook
// (#364, #1465) and a tier drop down a rung. Inferring the team from the agent
// breaks the moment an agent serves more than one bucket, and it can never show a
// tier drop at all.
describe("POST /api/bookings: the bucket the lead actually landed in (#1515)", () => {
  beforeEach(() => {
    regalKey.primary.mockReturnValue("secret");
  });

  it("reports the effective bucket beside the one that was requested", async () => {
    // A tier drop: the caller asked for 411 and the booking was placed in 421.
    service.bookViaApi.mockResolvedValue(
      result("created", {
        bucket_code: "421",
        tier_fallback: true,
        rungs_dropped: 1,
      }),
    );

    const body = await (await post("Bearer secret", VALID_BODY)).json();

    expect(body.bucket.code).toBe("421");
    expect(body.bucket.requestedCode).toBe("411");
    expect(body.bucket.tierFallback).toBe(true);
    expect(body.bucket.rungsDropped).toBe(1);
  });

  it("reports the requested bucket as the effective one when nothing moved", async () => {
    service.bookViaApi.mockResolvedValue(result("created"));

    const body = await (await post("Bearer secret", VALID_BODY)).json();

    expect(body.bucket.code).toBe("411");
    expect(body.bucket.requestedCode).toBe("411");
    // Absent from the trace means it did not happen, not that it is unknown:
    // every trace this path can return is written by the routing that placed the
    // booking, so a missing flag is a real false.
    expect(body.bucket.tierFallback).toBe(false);
    expect(body.bucket.rungsDropped).toBe(0);
  });

  it("names the bucket the lead is left in when the move was declined", async () => {
    // The case the field exists for: the caller asked for 411, the move was
    // refused, and the lead is still in 311. Reporting 411 here would say the
    // routing request landed when it was dropped.
    service.bookViaApi.mockResolvedValue({
      ...result("deduped", { bucket_code: "311" }),
      bucketChangeDeclined: "no_eligible_agents",
    });

    const body = await (await post("Bearer secret", VALID_BODY)).json();

    expect(body.bucket.code).toBe("311");
    expect(body.bucket.requestedCode).toBe("411");
    expect(body.bucketChangeDeclined.requestedBucketCode).toBe("411");
  });

  it("says the effective bucket is unknown rather than echoing the request", async () => {
    // Two of 1,146 production bookings predate the routing trace (both June 3rd,
    // neither active). Substituting the requested code would hand the caller a
    // team the lead may not be in, dressed as fact (L75); null says so instead.
    service.bookViaApi.mockResolvedValue(result("deduped", null));

    const body = await (await post("Bearer secret", VALID_BODY)).json();

    expect(body.bucket.code).toBeNull();
    expect(body.bucket.requestedCode).toBe("411");
  });
});

// #2643: trypennie's booking confirmed page renders the lead's contact and four add
// to calendar links. They ride on the confirm response too, so a caller learns them
// whether it fetches the booking afterwards or not, and from ONE builder.
describe("POST /api/bookings confirmation extras (#2643)", () => {
  const EXTRAS = {
    contact: { name: "Kris", email: "k@x.com", phone: "+12035615295" },
    calendarLinks: { google: "g", outlook: "o", office365: "m", ics: "i" },
  };
  beforeEach(() => {
    regalKey.primary.mockReturnValue("real-secret");
    regalKey.secondary.mockReturnValue("");
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
    service.bookingDetailExtras.mockReset();
    service.bookingDetailExtras.mockReturnValue(EXTRAS);
  });

  it("carries the contact and calendar links on every outcome that booked this caller's lead", async () => {
    for (const outcome of ["created", "rescheduled", "deduped"]) {
      service.bookViaApi.mockResolvedValue(result(outcome));
      const res = await post("Bearer real-secret", VALID_BODY);
      const body = await res.json();
      expect(body.booking).toMatchObject({ id: "bk-1", ...EXTRAS });
    }
    // Built from the booking the response names, not from the request.
    expect(service.bookingDetailExtras.mock.calls[0][0]).toMatchObject({ id: "bk-1" });
  });

  it("carries NEITHER on confirm_required, where the booking may be somebody else's (#1340)", async () => {
    service.bookViaApi.mockResolvedValue(result("confirm_required"));
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.booking).not.toHaveProperty("contact");
    expect(body.booking).not.toHaveProperty("calendarLinks");
    expect(service.bookingDetailExtras).not.toHaveBeenCalled();
  });
});

// #2645 asked for every booking API request to be attributable to its caller. A
// successful lookup wrote no line at all, so the first time a partner calls, only a
// log line saying WHICH key it presented can show its key was set correctly.
describe("GET /api/bookings lookup attribution (#2643, #2645)", () => {
  beforeEach(() => {
    regalKey.primary.mockReturnValue("real-secret");
    regalKey.secondary.mockReturnValue("");
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingApiReadWithinLimit.mockResolvedValue(true);
    service.getPersonBookingById.mockReset();
    service.getPersonBookingById.mockResolvedValue({ id: "bk-1" });
    service.lookupPersonBookings.mockReset();
    service.lookupPersonBookings.mockResolvedValue([]);
  });

  function lookup(query: string) {
    return GET(new Request(`http://localhost/api/bookings?${query}`, { headers: { authorization: "Bearer real-secret" } }) as never);
  }

  it("logs the caller on a by id lookup, at a queryable level", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await lookup("externalId=00Q1&bookingId=bk-1");
    expect(res.status).toBe(200);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('msg="lookup"'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('key="regal:primary"'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('mode="by_id"'));
    info.mockRestore();
  });

  it("logs the caller on a list page too", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    service.listBookings.mockResolvedValue({ items: [], nextCursor: null });
    await lookup("status=confirmed");
    expect(info).toHaveBeenCalledWith(expect.stringContaining('mode="list"'));
    info.mockRestore();
  });

  it("logs the caller on a per person lookup too", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await lookup("externalId=00Q1");
    expect(info).toHaveBeenCalledWith(expect.stringContaining('mode="person"'));
    info.mockRestore();
  });
});

// #2659: the partner join keys a landing page put on the booking ride on the
// confirm response, null when the booking has none, so a caller learns them
// without a second read. Read off the BOOKING's own prefill, never the request:
// on a `deduped` or `rescheduled` outcome the booking named is the one the lead
// already held, and its keys are the ones the warehouse will join on.
describe("POST /api/bookings partner join keys (#2659)", () => {
  beforeEach(() => {
    regalKey.primary.mockReturnValue("real-secret");
    regalKey.secondary.mockReturnValue("");
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
  });

  function withPrefill(outcome: string, prefill: Record<string, string> | undefined) {
    const r = result(outcome);
    return { ...r, booking: { ...r.booking, prefill } };
  }

  it("carries both from the booking's prefill on every outcome that booked this caller's lead", async () => {
    for (const outcome of ["created", "rescheduled", "deduped"]) {
      service.bookViaApi.mockResolvedValue(
        withPrefill(outcome, { [PARTNER_KEYS.submissionId]: "a0G5x00000AbCdEQAU", [PARTNER_KEYS.regalProfileId]: "rp_01HZY3" }),
      );
      const res = await post("Bearer real-secret", VALID_BODY);
      const body = await res.json();
      expect(body.booking).toMatchObject({ submissionId: "a0G5x00000AbCdEQAU", regalProfileId: "rp_01HZY3" });
    }
  });

  it("answers null, not a missing field, when the booking has neither", async () => {
    service.bookViaApi.mockResolvedValue(withPrefill("created", { utm_source: "google" }));
    const res = await post("Bearer real-secret", VALID_BODY);
    const body = await res.json();
    expect(body.booking.submissionId).toBeNull();
    expect(body.booking.regalProfileId).toBeNull();
  });

  it("withholds them on confirm_required, where the booking may be somebody else's (#1340)", async () => {
    service.bookViaApi.mockResolvedValue(
      withPrefill("confirm_required", { [PARTNER_KEYS.submissionId]: "a0G5x00000AbCdEQAU" }),
    );
    const res = await post("Bearer real-secret", VALID_BODY);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.booking).not.toHaveProperty("submissionId");
    expect(body.booking).not.toHaveProperty("regalProfileId");
  });
});

// #2669: the test bucket opt in follows the CALLER. Since #2645 each partner holds
// its own key, and a partner key could book the canary's hidden SMOKE buckets while
// the availability route refused to let it read them. The service is mocked here, so
// the fake below applies the service's own rule (a test bucket without the opt in is
// the same UnknownBucketError an unknown code is), and what is asserted is the wiring:
// which callers the route hands the opt in to, and that the refusal a partner meets
// is byte identical to a typo's (#601).
describe("POST /api/bookings: who may book a test bucket (#2669)", () => {
  const TEST_CODES = new Set<string>([...HIDDEN_TEST_BUCKET_CODES, ...PUBLIC_TEST_BUCKET_CODES]);
  type GateInput = { bucketCode: string; allowTestBuckets?: boolean };
  const gate = async (input: GateInput) => {
    if (input.bucketCode === "411") return result("created", { bucket_code: "411" });
    if (TEST_CODES.has(input.bucketCode) && input.allowTestBuckets) {
      return result("created", { bucket_code: input.bucketCode });
    }
    throw new service.UnknownBucketError("Unknown bucket");
  };

  beforeEach(() => {
    regalKey.primary.mockReturnValue("");
    regalKey.secondary.mockReturnValue("");
    env.bookingApiKeyFor.mockImplementation((caller: string, slot: string) =>
      slot === "primary" && (caller === "canary" || caller === "trypennie") ? `${caller}-secret` : "",
    );
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
    service.bookViaApi.mockReset();
    service.bookViaApi.mockImplementation(gate);
    service.previewBooking.mockReset();
    service.previewBooking.mockImplementation(async (input: GateInput) => {
      await gate(input);
      return { dryRun: true, outcome: "created", wouldAssign: null, existingBookingId: null };
    });
  });

  afterEach(() => {
    env.bookingApiKeyFor.mockReset();
    env.bookingApiKeyFor.mockImplementation(regalKeyFor);
  });

  it("the canary's own key books the hidden SMOKE bucket", async () => {
    const res = await post("Bearer canary-secret", { ...VALID_BODY, bucketCode: "SMOKE" });
    expect(res.status).toBe(200);
    expect(service.bookViaApi).toHaveBeenCalledWith(expect.objectContaining({ allowTestBuckets: true }));
  });

  it("a partner key booking SMOKE gets the byte identical 422 an unknown code gets", async () => {
    const hidden = await post("Bearer trypennie-secret", { ...VALID_BODY, bucketCode: "SMOKE" });
    const unknown = await post("Bearer trypennie-secret", { ...VALID_BODY, bucketCode: "NOPE" });
    expect(service.bookViaApi).toHaveBeenNthCalledWith(1, expect.objectContaining({ allowTestBuckets: false }));
    expect(hidden.status).toBe(422);
    expect(unknown.status).toBe(422);
    expect(await hidden.text()).toBe(await unknown.text());
    expect([...hidden.headers.entries()]).toEqual([...unknown.headers.entries()]);
  });

  it("a partner key's dry run cannot probe SMOKE either", async () => {
    const hidden = await post("Bearer trypennie-secret", { ...VALID_BODY, bucketCode: "SMOKE", dryRun: true });
    const unknown = await post("Bearer trypennie-secret", { ...VALID_BODY, bucketCode: "NOPE", dryRun: true });
    expect(hidden.status).toBe(422);
    expect(await hidden.text()).toBe(await unknown.text());
    // Positive control: the canary's dry run does reach it, so the 422 above is the gate.
    const canary = await post("Bearer canary-secret", { ...VALID_BODY, bucketCode: "SMOKE", dryRun: true });
    expect(canary.status).toBe(200);
  });

  it("a partner key books the PUBLIC test bucket, which exists for partners", async () => {
    const res = await post("Bearer trypennie-secret", { ...VALID_BODY, bucketCode: PUBLIC_TEST });
    expect(res.status).toBe(200);
    expect(service.bookViaApi).toHaveBeenCalledWith(
      expect.objectContaining({ bucketCode: PUBLIC_TEST, allowTestBuckets: true }),
    );
  });

  it("a partner key on a real code carries no test opt in", async () => {
    const res = await post("Bearer trypennie-secret", VALID_BODY);
    expect(res.status).toBe(200);
    expect(service.bookViaApi).toHaveBeenCalledWith(expect.objectContaining({ allowTestBuckets: false }));
  });
});

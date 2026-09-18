import { describe, it, expect, vi, beforeEach } from "vitest";
// The pure half, deliberately NOT mocked: the route's key shape is what these assert on.
import { rateLimitKey, type CallerKey } from "@/lib/rate-limit-core";

// Error mapping for the public embed booking route. Focus of #358: an
// empty/misconfigured bucket now throws NoEligibleAgentsError (was
// SlotUnavailableError) — the consumer must still see "no times" (409), not a
// 500. createBooking + rate-limit are mocked so this exercises only the route's
// validation + error mapping.

const service = vi.hoisted(() => {
  class SlotUnavailableError extends Error {}
  class VerifyUnavailableError extends Error {}
  class NoEligibleAgentsError extends Error {}
  // #1337: the route declines rather than creating when the person already has
  // an active call. The class must exist on the mock for the instanceof branch.
  class ExistingCallError extends Error {
    existingCall: unknown;
    constructor(existingCall: unknown) {
      super("already has a call");
      this.existingCall = existingCall;
    }
  }
  // #1641: the one-call-per-person check could not be MADE (its bookings read
  // failed). The route refuses with a retriable 503 rather than letting the read
  // failure read as "this lead has no call" and creating a duplicate.
  class ExistingCallCheckUnavailableError extends Error {}
  return {
    createBooking: vi.fn(),
    // Mirrors DuplicateWarning in src/lib/booking/orchestration.ts: a weak
    // one-signal identity match arrives as the bare `disclose: false` (#1340).
    findDuplicateBookingWarning: vi.fn(
      async (): Promise<
        | { disclose: true; startsAt: string; manageUrl: string }
        | { disclose: false }
        | null
      > => null,
    ),
    SlotUnavailableError,
    VerifyUnavailableError,
    NoEligibleAgentsError,
    ExistingCallError,
    ExistingCallCheckUnavailableError,
  };
});
const rateLimit = vi.hoisted(() => ({
  allowRequest: vi.fn(async (_caller: unknown, _rules?: unknown) => true),
  refundRequest: vi.fn(async (_caller: unknown, _rules?: unknown) => {}),
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

const recordApiOutcome = vi.hoisted(() => vi.fn());
const bookingSettings = vi.hoisted(() => ({
  // Open by default, so every pre-existing test in this file still exercises the
  // ordinary path rather than silently testing a paused booker.
  readPublicBookingPaused: vi.fn(async (): Promise<boolean | null> => false),
}));
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/monitor/record-api-outcome", () => ({ recordApiOutcome }));

// #2297: the kill switch's DB reader is the seam. The pure judge
// (`judgePublicBooking`) is deliberately NOT mocked, so these drive the real
// decision, including the direction it fails in.
vi.mock("@/lib/booking/settings", () => bookingSettings);

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
    const keysRefunded = rateLimit.refundRequest.mock.calls.map((c) => rateLimitKey(c[0] as CallerKey));
    expect(keysRefunded).toContain("203.0.113.1");
    expect(keysRefunded).toContain("email:dana@example.com");
    expect(keysRefunded).toContain("phone:2155550100");
  });

  it("answers a retriable 503 when the existing-call check could not be made (#1641)", async () => {
    service.createBooking.mockRejectedValueOnce(
      new service.ExistingCallCheckUnavailableError(
        "We hit a temporary issue booking this time. Please try again in a moment.",
      ),
    );
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    // One short human sentence, and nothing about the read that failed: the
    // table name, the driver message and the stack belong in the log only.
    expect(body.error).toBe(
      "We hit a temporary issue booking this time. Please try again in a moment.",
    );
    expect(JSON.stringify(body)).not.toMatch(/bookings|select|supabase|Error:/i);
    // A fault on our side must not burn the lead's budget, so they can retry at
    // once. Same refund set as the other transient 503.
    expect(rateLimit.refundRequest).toHaveBeenCalledTimes(3);
    const keysRefunded = rateLimit.refundRequest.mock.calls.map((c) => rateLimitKey(c[0] as CallerKey));
    expect(keysRefunded).toContain("203.0.113.1");
    expect(keysRefunded).toContain("email:dana@example.com");
    expect(keysRefunded).toContain("phone:2155550100");
    // Counted as an error under its own code, so the booking-failure-rate window
    // (#1313) names it rather than a run of these hiding inside "internal".
    expect(recordApiOutcome).toHaveBeenCalledWith(
      "error",
      "411",
      "existing_call_unavailable",
      { by: "bucket", code: "411" },
    );
  });

  it("refunds the IP cap AND both contact keys on a taken-slot 409, which isn't the lead's fault (#1089)", async () => {
    service.createBooking.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(409);
    // Same refund set as the 503 verify-outage path: a slot grabbed by someone
    // else a moment earlier must not burn a real lead's IP or contact budget.
    expect(rateLimit.refundRequest).toHaveBeenCalledTimes(3);
    const keysRefunded = rateLimit.refundRequest.mock.calls.map((c) => rateLimitKey(c[0] as CallerKey));
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
    rateLimit.allowRequest.mockImplementation(
      async (caller: unknown) => !rateLimitKey(caller as CallerKey).startsWith("email:"),
    );
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
    const keysChecked = rateLimit.allowRequest.mock.calls.map((c) => rateLimitKey(c[0] as CallerKey));
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
      disclose: true,
      startsAt: "2026-07-02T18:00:00.000Z",
      manageUrl: "https://slate.test/booking/manage/tok-old",
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "bk-2",
      duplicateWarning: {
        disclose: true,
        startsAt: "2026-07-02T18:00:00.000Z",
        manageUrl: "https://slate.test/booking/manage/tok-old",
      },
    });
    // Detection excludes the just-created booking and matches by attendee.
    expect(service.findDuplicateBookingWarning).toHaveBeenCalledWith(
      expect.objectContaining({ excludeBookingId: "bk-2" }),
    );
  });

  // #1337: one call per person is enforced here. The route opts in (the direct
  // booking API must not, since its cross-bucket rebook creates before it
  // cancels, #364), and a decline reaches the client as a 409 carrying the call
  // they already have, with nothing created.
  it("opts into refusing a second booking for someone who already has a call (#1337)", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-9", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    await post(VALID_BODY);
    expect(service.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({ refuseIfPersonHasCall: true }),
    );
  });

  it("declines with a 409 naming the existing call, and refunds the rate limit (#1337)", async () => {
    service.createBooking.mockRejectedValue(
      new service.ExistingCallError({
        disclose: true,
        startsAt: "2026-07-02T18:00:00.000Z",
        advisorName: "Aisha Bello",
        manageToken: "tok-old",
      }),
    );
    const res = await post(VALID_BODY);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      existingCall: {
        disclose: true,
        startsAt: "2026-07-02T18:00:00.000Z",
        advisorName: "Aisha Bello",
        manageToken: "tok-old",
      },
    });
    // Being declined is not an attempt the lead should pay for, and the Move they
    // are about to make is a separate request.
    expect(rateLimit.refundRequest).toHaveBeenCalled();
  });

  it("passes a withheld existing call through carrying no details (#1337/#1340)", async () => {
    service.createBooking.mockRejectedValue(
      new service.ExistingCallError({ disclose: false }),
    );
    const res = await post(VALID_BODY);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.existingCall).toEqual({ disclose: false });
    expect(JSON.stringify(body)).not.toContain("tok-old");
  });

  // #1340: the route is the wire between the strict disclosure decision and the
  // booker. A withheld match must reach the client as the bare refusal, with no
  // start time and no manage url reconstructed anywhere along the way.
  it("passes a withheld match through carrying no booking details (#1340)", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-3", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok-new",
    });
    service.findDuplicateBookingWarning.mockResolvedValue({ disclose: false });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicateWarning).toEqual({ disclose: false });
    // The only manage url in the response is the lead's own new booking.
    expect(JSON.stringify(body)).not.toContain("tok-old");
  });
});

// #1313: the embed booker is the surface most customers actually book through,
// and its outcomes were not counted at all, so the tally the admin panel reads
// (and any rate signal built on it) was blind to the busiest route. Every branch
// records, including the refusals, because the failure MIX is the thing worth
// watching: one customer losing a race is ordinary contention, and fifty refused
// in two hours is the cal.com failure of 2026-08-06, which nothing could tell
// apart without a count.
describe("POST /booking outcome tally (#1313)", () => {
  beforeEach(() => recordApiOutcome.mockClear());
  const outcomes = () => recordApiOutcome.mock.calls.map((c) => [c[0], c[2]]);

  it("counts a successful booking", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    await post(VALID_BODY);
    expect(outcomes()).toEqual([["created", null]]);
    // Always with the bucket, so a failure confined to one bucket is visible.
    expect(recordApiOutcome.mock.calls[0][1]).toBe(VALID_BODY.bucketCode);
  });

  // #1318: the two 400s were a customer refused with nothing anywhere counting it.
  // The live case is #1425, which made a phone number carrying an extension a
  // refusal: any upstream source still sending one now fails EVERY time, and without
  // this count the only symptom is a quieter funnel.
  it("counts a request whose body Slate rejects", async () => {
    const res = await post({ ...VALID_BODY, timezone: 42 });
    expect(res.status).toBe(400);
    expect(outcomes()).toEqual([["error", "invalid_request"]]);
    // The bucket is read off the RAW body, which is the only place it exists when the
    // parse is what failed, so a fault confined to one bucket stays visible.
    expect(recordApiOutcome.mock.calls[0][1]).toBe(VALID_BODY.bucketCode);
  });

  it("counts contact details Slate will not take, under a different code", async () => {
    const res = await post({
      ...VALID_BODY,
      attendee: { ...VALID_BODY.attendee, phone: "2155550100 x4021" },
    });
    expect(res.status).toBe(400);
    // Its own code, not the schema one: a wave of each means a different thing, and a
    // page naming "invalid_request" for a contact rule would send the reader to the
    // wrong place.
    expect(outcomes()).toEqual([["error", "invalid_contact"]]);
  });

  it("counts NOTHING for a bot tripping the honeypot", async () => {
    const res = await post({ ...VALID_BODY, website: "http://spam.example" });
    expect(res.status).toBe(400);
    // Deliberate (#1318). `attempts` is every recorded outcome summed, so counting a
    // bot would put its volume in the denominator the failure share is measured
    // against and make a real outage look proportionally smaller while it floods.
    expect(outcomes()).toEqual([]);
  });

  it("counts a slot refused at confirm under its own code", async () => {
    service.createBooking.mockRejectedValue(new service.SlotUnavailableError("taken"));
    await post(VALID_BODY);
    expect(outcomes()).toEqual([["error", "slot_unavailable"]]);
  });

  it("counts an empty pool apart from a lost slot race", async () => {
    service.createBooking.mockRejectedValue(new service.NoEligibleAgentsError("none"));
    await post(VALID_BODY);
    expect(outcomes()).toEqual([["error", "no_eligible_agents"]]);
  });

  it("counts a verify outage apart from both", async () => {
    service.createBooking.mockRejectedValue(new service.VerifyUnavailableError("down"));
    await post(VALID_BODY);
    expect(outcomes()).toEqual([["error", "verify_unavailable"]]);
  });

  it("counts a refused second booking as a dedupe, not an error", async () => {
    service.createBooking.mockRejectedValue(
      new service.ExistingCallError({ disclose: false }),
    );
    await post(VALID_BODY);
    // Declining a duplicate is the product working, so it must not inflate the
    // failure share the rate signal will watch.
    expect(outcomes()).toEqual([["deduped", "existing_call"]]);
  });

  it("counts an unexpected failure rather than losing it", async () => {
    service.createBooking.mockRejectedValue(new Error("something else"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(500);
    expect(outcomes()).toEqual([["error", "internal"]]);
  });
});

// The public booking kill switch (#2297). What is asserted here is not that a flag
// works, it is the three things that make the switch worth having: nothing is
// created while it is on, a lead's booking budget is not spent on a refusal they
// did not cause, and a flag that CANNOT be read refuses rather than booking on.
describe("POST /booking kill switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.bookingWithinLimit.mockResolvedValue(true);
    rateLimit.allowRequest.mockResolvedValue(true);
    bookingSettings.readPublicBookingPaused.mockResolvedValue(false);
    service.createBooking.mockResolvedValue({
      booking: { id: "b1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:20:00.000Z" },
      manageUrl: "https://example.test/manage/t",
    });
  });

  it("creates nothing and refuses with 503 while bookings are paused", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValue(true);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    expect(service.createBooking).not.toHaveBeenCalled();
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  // The switch is an operator action, so the lead did nothing wrong. Spending one
  // of their ten an hour on it would mean a pause that lasted an hour left real
  // leads throttled after it was lifted.
  it("does not spend the lead's hourly or contact budget on a paused refusal", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValue(true);
    await post(VALID_BODY);
    expect(rateLimit.allowRequest).not.toHaveBeenCalled();
  });

  // Both halves, so neither assertion can be satisfied by a route hard wired to
  // one answer (L1): the SAME request books when the flag reads false.
  it("books exactly as before when the flag reads false", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValue(false);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(service.createBooking).toHaveBeenCalledTimes(1);
  });

  // The direction that makes the switch trustworthy. A read failure must not
  // resolve to "not paused", which is the #277 shape.
  it("refuses, and creates nothing, when the pause flag cannot be read", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValue(null);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  // An unreadable flag is a fault somebody has to repair; a pause is somebody
  // holding bookings on purpose. They must not arrive as the same thing, or the
  // pause explains away the fault (L11).
  it("says something different to the lead, and records differently, for a fault than for a pause", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValue(true);
    const pausedBody = await (await post(VALID_BODY)).json();
    const pausedOutcomes = recordApiOutcome.mock.calls.slice();

    recordApiOutcome.mockClear();
    bookingSettings.readPublicBookingPaused.mockResolvedValue(null);
    const faultBody = await (await post(VALID_BODY)).json();
    const faultOutcomes = recordApiOutcome.mock.calls.slice();

    expect(faultBody.error).not.toBe(pausedBody.error);
    // The fault is counted as an error under its own code, so the booking
    // failure-rate window pages on the share and names it. The deliberate pause
    // is not, because it would page somebody about a thing they just did.
    expect(faultOutcomes.some((c) => c[0] === "error" && c[2] === "booking_pause_unreadable")).toBe(true);
    expect(pausedOutcomes.some((c) => c[0] === "error")).toBe(false);
  });
});

// #2561: the confirm's answer names one lead's booking and carries the manage URL a
// cancel or reschedule is authorised by. Nothing between the browser and the Worker
// was told not to keep it, so a shared cache (a corporate proxy, an ISP one, a
// back/forward store) could hand one lead's confirmation to the next reader. Every
// ending is asserted, not just the happy one: the header is applied by wrapping the
// handler rather than by stamping each of its thirteen returns, and the thing worth
// proving about a wrapper is that a return nobody remembered still carries it (L96).
describe("confirm answers are never stored (#2561)", () => {
  const noStore = (res: Response) => res.headers.get("cache-control");

  beforeEach(() => {
    rateLimit.allowRequest.mockReset();
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingWithinLimit.mockReset();
    rateLimit.bookingWithinLimit.mockResolvedValue(true);
    service.createBooking.mockReset();
    service.findDuplicateBookingWarning.mockReset();
    service.findDuplicateBookingWarning.mockResolvedValue(null);
    bookingSettings.readPublicBookingPaused.mockResolvedValue(false);
  });

  it("on a confirmed booking", async () => {
    service.createBooking.mockResolvedValueOnce({
      booking: { id: "b1", starts_at: "2026-07-01T15:00:00Z", ends_at: "2026-07-01T15:30:00Z", agent_name: "A", agent_email: "a@b.com" },
      manageUrl: "https://slate.trypennie.app/booking/manage/tok1",
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(noStore(res)).toBe("no-store");
  });

  it("on a rejected body, which never reaches the booking layer", async () => {
    const res = await post({ ...VALID_BODY, bucketCode: "" });
    expect(res.status).toBe(400);
    expect(noStore(res)).toBe("no-store");
  });

  it("on a throttled address, the one refusal a cache could replay for free", async () => {
    rateLimit.bookingWithinLimit.mockResolvedValueOnce(false);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(429);
    expect(noStore(res)).toBe("no-store");
  });

  it("while public booking is paused, which answers from the kill switch", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValueOnce(true);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    expect(noStore(res)).toBe("no-store");
  });

  it("on a taken slot, which answers 409 through the error map", async () => {
    service.createBooking.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(409);
    expect(noStore(res)).toBe("no-store");
  });

  it("on an unexpected fault, which returns through a different helper entirely", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.createBooking.mockRejectedValueOnce(new Error("boom"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(500);
    expect(noStore(res)).toBe("no-store");
  });
});

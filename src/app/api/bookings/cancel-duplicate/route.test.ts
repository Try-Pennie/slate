import { describe, it, expect, vi, beforeEach } from "vitest";

// #2369: the HTTP surface of POST /api/bookings/cancel-duplicate.
//
// The decision itself is one database call and is tested where it lives
// (scripts/test-duplicate-cancel.ts, scripts/test-duplicate-cancel-person-match.ts).
// What is exercised here is everything between the wire and that call: the bearer
// gate, the body, the outcome-to-status mapping, and the two ways this route must
// FAIL CLOSED rather than answer a refusal it never measured.
//
// The real `bearerTokenMatches` runs (not mocked), so the constant-time compare is
// part of the test; only the env key and the mutating service call are stubbed.
const env = vi.hoisted(() => ({ duplicateCancelApiKey: vi.fn(() => "dup-k3y") }));
const service = vi.hoisted(() => {
  // The route maps by typed error CLASS, so the mock must expose the same class the
  // route does `instanceof` against.
  class DuplicateCancelUnavailableError extends Error {
    stage: string;
    constructor(stage: string) {
      super(`duplicate cancel incomplete: ${stage}`);
      this.name = "DuplicateCancelUnavailableError";
      this.stage = stage;
    }
  }
  return { cancelDuplicateBooking: vi.fn(), DuplicateCancelUnavailableError };
});

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/booking/service", () => service);
// The route imports the real error class from the pure module, so nothing is mocked
// there; the service mock re-declares a structurally identical one and the route's
// `instanceof` is against the REAL one, which is why the unavailable cases below
// throw the real class rather than the mock's.
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { POST } = await import("./route");
const { DuplicateCancelUnavailableError } = await import("@/lib/booking/duplicate-cancel");

const request = (body: unknown, auth: string | null = "Bearer dup-k3y") =>
  new Request("https://slate.test/api/bookings/cancel-duplicate", {
    method: "POST",
    headers: auth ? { authorization: auth, "content-type": "application/json" } : {},
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const answered = (outcome: string, over: Record<string, unknown> = {}) => ({
  result: { outcome, outboxId: null, candidateIds: [], weakerMatch: null, ...over },
  handoff: null,
  delivered: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  env.duplicateCancelApiKey.mockReturnValue("dup-k3y");
});

describe("auth", () => {
  it("answers 503 when no key is configured, and never reaches the service", async () => {
    env.duplicateCancelApiKey.mockReturnValue("");
    const res = await POST(request({ bookingId: "bk-1" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "NOT_CONFIGURED" });
    expect(service.cancelDuplicateBooking).not.toHaveBeenCalled();
  });

  it("answers 401 on a wrong key, and never reaches the service", async () => {
    const res = await POST(request({ bookingId: "bk-1" }, "Bearer nope"));
    expect(res.status).toBe(401);
    expect(service.cancelDuplicateBooking).not.toHaveBeenCalled();
  });

  it("answers 401 with no Authorization header at all", async () => {
    const res = await POST(request({ bookingId: "bk-1" }, null));
    expect(res.status).toBe(401);
    expect(service.cancelDuplicateBooking).not.toHaveBeenCalled();
  });
});

describe("the body", () => {
  it("answers 400 when no booking is named", async () => {
    const res = await POST(request({ laterBookingStartsAt: "2026-09-17T15:00:00.000Z" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION" });
    expect(service.cancelDuplicateBooking).not.toHaveBeenCalled();
  });

  it("answers 400 on a blank booking id, so a journey sending nothing is told", async () => {
    const res = await POST(request({ bookingId: "   " }));
    expect(res.status).toBe(400);
  });

  it("passes the reported later start through exactly as sent", async () => {
    service.cancelDuplicateBooking.mockResolvedValue(
      answered("no-other-call", { weakerMatch: "phone-only" }),
    );
    await POST(request({ bookingId: "bk-1", laterBookingStartsAt: " 2026-09-17T15:00:00.000Z " }));
    expect(service.cancelDuplicateBooking).toHaveBeenCalledWith({
      bookingId: "bk-1",
      laterBookingStartsAt: "2026-09-17T15:00:00.000Z",
    });
  });

  it("reports no later start when the caller sent none", async () => {
    service.cancelDuplicateBooking.mockResolvedValue(answered("no-other-call"));
    await POST(request({ bookingId: "bk-1" }));
    expect(service.cancelDuplicateBooking).toHaveBeenCalledWith({
      bookingId: "bk-1",
      laterBookingStartsAt: null,
    });
  });

  it("reports no later start when the caller sent a non-string, rather than coercing one", async () => {
    service.cancelDuplicateBooking.mockResolvedValue(answered("no-other-call"));
    await POST(request({ bookingId: "bk-1", laterBookingStartsAt: 1758124800000 }));
    expect(service.cancelDuplicateBooking).toHaveBeenCalledWith({
      bookingId: "bk-1",
      laterBookingStartsAt: null,
    });
  });
});

describe("the outcomes", () => {
  it("answers 200 on a cancel", async () => {
    service.cancelDuplicateBooking.mockResolvedValue({
      result: { outcome: "cancelled", outboxId: "ob-1", candidateIds: ["bk-2"], weakerMatch: null },
      handoff: null,
      delivered: true,
    });
    const res = await POST(request({ bookingId: "bk-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ outcome: "cancelled", code: "CANCELLED" });
    expect(body.finding).toBeUndefined();
  });

  it("answers 200 on a retry after a success, so a journey is never told a success failed", async () => {
    service.cancelDuplicateBooking.mockResolvedValue(answered("already-cancelled"));
    const res = await POST(request({ bookingId: "bk-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "already-cancelled", code: "ALREADY_CANCELLED" });
  });

  it("answers 200 even when the inline delivery was deferred to the drain", async () => {
    service.cancelDuplicateBooking.mockResolvedValue({
      result: { outcome: "cancelled", outboxId: "ob-1", candidateIds: [], weakerMatch: null },
      handoff: null,
      delivered: null,
    });
    const res = await POST(request({ bookingId: "bk-1" }));
    expect(res.status).toBe(200);
  });

  it.each([
    ["not-found", "BOOKING_NOT_FOUND"],
    ["not-active", "BOOKING_NOT_ACTIVE"],
    ["started", "BOOKING_STARTED"],
    ["identity-conflict", "IDENTITY_CONFLICT"],
    ["named-is-newest", "NAMED_IS_NEWEST"],
    ["no-other-call", "NO_OTHER_CALL"],
  ])("answers 409 %s with its own code", async (outcome, code) => {
    service.cancelDuplicateBooking.mockResolvedValue(answered(outcome));
    const res = await POST(request({ bookingId: "bk-1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ outcome, code });
  });

  it.each(["identity-conflict", "named-is-newest", "no-other-call"])(
    "reports the handoff and the weaker match on %s, so a retry reads as the same refusal",
    async (outcome) => {
      service.cancelDuplicateBooking.mockResolvedValue({
        result: { outcome, outboxId: null, candidateIds: [], weakerMatch: "email-only" },
        handoff: "already-recorded",
        delivered: null,
      });
      const res = await POST(request({ bookingId: "bk-1" }));
      expect(await res.json()).toMatchObject({
        finding: outcome,
        handoff: "already-recorded",
        weakerMatch: "email-only",
      });
    },
  );

  it.each(["not-found", "not-active", "started"])(
    "records nothing on %s, because nobody is waiting on a person",
    async (outcome) => {
      service.cancelDuplicateBooking.mockResolvedValue(answered(outcome));
      const body = await (await POST(request({ bookingId: "bk-1" }))).json();
      expect(body.finding).toBeUndefined();
      expect(body.handoff).toBeUndefined();
    },
  );
});

describe("failing closed", () => {
  it.each(["rpc", "result", "handoff"] as const)(
    "answers 503 naming the %s stage, never a refusal",
    async (stage) => {
      service.cancelDuplicateBooking.mockRejectedValue(new DuplicateCancelUnavailableError(stage));
      const res = await POST(request({ bookingId: "bk-1" }));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toMatchObject({ code: "DUPLICATE_CHECK_UNAVAILABLE", stage });
      // The one thing it must never do: report an outcome it did not measure.
      expect(body.outcome).toBeUndefined();
      expect(body.finding).toBeUndefined();
    },
  );

  it("answers 503 on an unexpected failure too, rather than a 500 a journey would give up on", async () => {
    service.cancelDuplicateBooking.mockRejectedValue(new Error("something else entirely"));
    const res = await POST(request({ bookingId: "bk-1" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("DUPLICATE_CHECK_UNAVAILABLE");
    // And it never leaks the underlying text.
    expect(JSON.stringify(body)).not.toContain("something else entirely");
  });
});

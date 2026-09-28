import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/bookings/cancel (#2591): the key authed cancel in a form a Regal journey can
// send, because its webhook step offers GET, POST, PUT and PATCH and no DELETE. It is
// the SAME cancel as DELETE /api/bookings, so most of what is asserted here is asserted
// of both verbs through one table: a second implementation would be free to drift.
//
// Seams, every one named (L284). Mocked: env (the key), rate-limit (IO), the booking
// service (the cancel itself), reason options (a database read), the internal error
// reporter (it alerts). Left REAL on purpose: the authorizer, the parsers, the write
// failure class and the error mapping, since those are the glue under test.

// #2865: the key these tests authenticate with is Regal's. There is no shared caller.
const regalKey = vi.hoisted(() => ({ primary: vi.fn(() => "real-secret"), secondary: vi.fn(() => "") }));
const env = vi.hoisted(() => ({
  bookingApiKeyFor: vi.fn((caller: string, slot: string) =>
    caller !== "regal" ? "" : slot === "primary" ? regalKey.primary() : regalKey.secondary(),
  ),
}));
const rateLimit = vi.hoisted(() => ({
  allowRequest: vi.fn(async (_caller: unknown, _rules: unknown) => true),
  bookingApiWriteWithinLimit: vi.fn(async (_keyId: string) => true),
  bookingApiReadWithinLimit: vi.fn(async (_keyId: string) => true),
  bookingApiIpWithinLimit: vi.fn(async (_ip: string) => true),
  clientIp: (headers: Headers) => headers.get("cf-connecting-ip")?.trim() ?? "unknown",
}));
const service = vi.hoisted(() => {
  class BookingNotFoundError extends Error {}
  class SlotUnavailableError extends Error {}
  class VerifyUnavailableError extends Error {}
  class NoEligibleAgentsError extends Error {}
  class UnknownBucketError extends Error {}
  return {
    cancelDirectBooking: vi.fn(),
    bookViaApi: vi.fn(),
    previewBooking: vi.fn(),
    lookupPersonBookings: vi.fn(),
    getPersonBookingById: vi.fn(),
    listBookings: vi.fn(),
    BookingNotFoundError,
    SlotUnavailableError,
    VerifyUnavailableError,
    NoEligibleAgentsError,
    UnknownBucketError,
  };
});
const reasons = vi.hoisted(() => ({ loadReasonOptions: vi.fn() }));
const errors = vi.hoisted(() => ({
  GENERIC_ERROR_MESSAGE: "Something went wrong.",
  reportInternalError: vi.fn(async () => {}),
}));
const monitor = vi.hoisted(() => ({ recordApiOutcome: vi.fn() }));

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/booking/reason-options", () => reasons);
vi.mock("@/lib/api/errors", () => errors);
vi.mock("@/lib/monitor/record-api-outcome", () => monitor);

import { POST } from "./route";
import { DELETE } from "../route";
import { CANCEL_REASONS } from "@/lib/booking/core";
import { BookingWriteFailedError } from "@/lib/booking/gated-write";

const VIEW = { id: "bk-7", status: "cancelled" };

type Fields = Record<string, string>;
type Verb = (fields: Fields, authorization?: string) => Promise<Response>;

const viaPost: Verb = (fields, authorization = "Bearer real-secret") =>
  POST(
    new Request("http://localhost/api/bookings/cancel", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(fields),
    }) as never,
  );

const viaDelete: Verb = (fields, authorization = "Bearer real-secret") => {
  const url = new URL("http://localhost/api/bookings");
  for (const [k, v] of Object.entries(fields)) url.searchParams.set(k, v);
  // The DELETE handler reads `req.nextUrl`, which a plain Request does not carry.
  const req = Object.assign(new Request(url, { method: "DELETE", headers: { authorization } }), {
    nextUrl: url,
  });
  return DELETE(req as never);
};

beforeEach(() => {
  regalKey.primary.mockReturnValue("real-secret");
  for (const f of [
    rateLimit.allowRequest,
    rateLimit.bookingApiWriteWithinLimit,
    rateLimit.bookingApiIpWithinLimit,
  ]) {
    f.mockClear();
    f.mockResolvedValue(true);
  }
  service.cancelDirectBooking.mockReset();
  service.cancelDirectBooking.mockResolvedValue(VIEW);
  reasons.loadReasonOptions.mockReset();
  reasons.loadReasonOptions.mockResolvedValue({ cancel: { all: CANCEL_REASONS } });
  errors.reportInternalError.mockClear();
});

describe.each([
  ["POST /api/bookings/cancel", viaPost],
  ["DELETE /api/bookings", viaDelete],
] as const)("%s: one cancel, whichever verb carries it (#2591)", (_name, send) => {
  it("cancels the named booking for the named lead and answers 200", async () => {
    const res = await send({ bookingId: "bk-7", salesforceId: "00Q5x000001abcEAA" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "cancelled", booking: VIEW });
    expect(service.cancelDirectBooking).toHaveBeenCalledExactlyOnceWith({
      bookingId: "bk-7",
      identity: { externalId: null, salesforceId: "00Q5x000001abcEAA" },
      reason: null,
    });
  });

  it("passes a valid reason through", async () => {
    await send({ bookingId: "bk-7", externalId: "ext-1", reason: "no_longer_interested" });
    expect(service.cancelDirectBooking.mock.calls[0][0].reason).toMatchObject({
      code: "no_longer_interested",
    });
  });

  it("refuses a wrong key with 401 and cancels nothing", async () => {
    const res = await send({ bookingId: "bk-7", externalId: "ext-1" }, "Bearer wrong");
    expect(res.status).toBe(401);
    expect(service.cancelDirectBooking).not.toHaveBeenCalled();
  });

  it("answers 503 when no key is configured, and cancels nothing", async () => {
    regalKey.primary.mockReturnValue("");
    const res = await send({ bookingId: "bk-7", externalId: "ext-1" });
    expect(res.status).toBe(503);
    expect(service.cancelDirectBooking).not.toHaveBeenCalled();
  });

  it("answers 429 past the write ceiling, and cancels nothing", async () => {
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(false);
    const res = await send({ bookingId: "bk-7", externalId: "ext-1" });
    expect(res.status).toBe(429);
    expect(service.cancelDirectBooking).not.toHaveBeenCalled();
  });

  it("answers 400 VALIDATION with no lead id, and cancels nothing", async () => {
    const res = await send({ bookingId: "bk-7" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "externalId or salesforceId is required",
      code: "VALIDATION",
    });
    expect(service.cancelDirectBooking).not.toHaveBeenCalled();
  });

  it("answers 404 NOT_FOUND when the booking is not that lead's, or not active", async () => {
    service.cancelDirectBooking.mockRejectedValue(new service.BookingNotFoundError("Booking not found"));
    const res = await send({ bookingId: "bk-7", externalId: "someone-else" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("answers 503 WRITE_FAILED when the cancel did not run, so the caller retries", async () => {
    service.cancelDirectBooking.mockRejectedValue(new BookingWriteFailedError("cancel_claim", "deadlock detected"));
    const res = await send({ bookingId: "bk-7", externalId: "ext-1" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("WRITE_FAILED");
    // The database's own text is for the log, never for the caller.
    expect(JSON.stringify(body)).not.toContain("deadlock");
  });

  it("answers a generic 500 for anything unexpected, reports it, and leaks nothing", async () => {
    service.cancelDirectBooking.mockRejectedValue(new Error('relation "bookings" does not exist'));
    const res = await send({ bookingId: "bk-7", externalId: "ext-1" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong.", code: "INTERNAL" });
    expect(errors.reportInternalError).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/bookings/cancel: what only a body can get wrong", () => {
  it("answers 400 naming the body when it is not JSON, and cancels nothing", async () => {
    const res = await POST(
      new Request("http://localhost/api/bookings/cancel", {
        method: "POST",
        headers: { authorization: "Bearer real-secret", "content-type": "application/json" },
        body: "{not json",
      }) as never,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be a JSON object", code: "VALIDATION" });
    expect(service.cancelDirectBooking).not.toHaveBeenCalled();
  });

  it("never reads the body of an unauthenticated request as an instruction", async () => {
    const res = await viaPost({ bookingId: "bk-7", externalId: "ext-1" }, "");
    expect(res.status).toBe(401);
    expect(reasons.loadReasonOptions).not.toHaveBeenCalled();
    expect(service.cancelDirectBooking).not.toHaveBeenCalled();
  });
});

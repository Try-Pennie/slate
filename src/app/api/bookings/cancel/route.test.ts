import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { DELETE, POST as BOOK, GET as LOOKUP } from "../route";
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

// #2940: a lead who opts out of their call by replying to a Marcia text. Regal's opt
// out journey sends exactly this body (the checklist on the issue), with the booking
// id and Lead id it holds on the contact. The reason store is the REAL resolver over
// a store written before `text_opt_out` existed, which is what production holds, so
// this proves the code is accepted on the day it ships rather than after somebody
// saves the reason editor.
describe("POST /api/bookings/cancel: a lead's opt out by text (#2940)", () => {
  const REGAL_OPT_OUT_BODY = {
    bookingId: "5f14aac7-ad33-4b8c-98cd-5fc5f5d7babc",
    salesforceId: "00QUi0000109rcTMAQ",
    reason: "text_opt_out",
  };

  beforeEach(async () => {
    const real = await vi.importActual<typeof import("@/lib/booking/reason-options")>(
      "@/lib/booking/reason-options",
    );
    reasons.loadReasonOptions.mockResolvedValue(
      real.resolveReasonOptions([
        { action: "cancel", code: "no_longer_interested", label: "No longer interested", sort_order: 0, active: true, locked: false, system_only: false },
        { action: "cancel", code: "other", label: "Other", sort_order: 1, active: true, locked: true, system_only: false },
        { action: "cancel", code: "double_booking", label: "Double booking", sort_order: 2, active: true, locked: true, system_only: true },
      ]),
    );
  });

  it("cancels the named booking for that Lead, recorded as an opt out by text", async () => {
    const res = await viaPost(REGAL_OPT_OUT_BODY);
    expect(res.status).toBe(200);
    expect(service.cancelDirectBooking).toHaveBeenCalledExactlyOnceWith({
      bookingId: REGAL_OPT_OUT_BODY.bookingId,
      identity: { externalId: null, salesforceId: REGAL_OPT_OUT_BODY.salesforceId },
      reason: { code: "text_opt_out", detail: null },
    });
  });

  it("is safe to run twice: the second call cancels nothing and answers 404", async () => {
    expect((await viaPost(REGAL_OPT_OUT_BODY)).status).toBe(200);
    // The cancel claim is atomic (#413): the second run finds the booking no longer
    // active and the service refuses it, so no second webhook or calendar delete.
    service.cancelDirectBooking.mockRejectedValueOnce(new service.BookingNotFoundError("Booking not found"));
    const second = await viaPost(REGAL_OPT_OUT_BODY);
    expect(second.status).toBe(404);
    expect((await second.json()).code).toBe("NOT_FOUND");
  });

  it("refuses a body with no booking id rather than guessing which call to cancel", async () => {
    const res = await viaPost({ salesforceId: REGAL_OPT_OUT_BODY.salesforceId, reason: "text_opt_out", bookingId: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bookingId is required", code: "VALIDATION" });
    expect(service.cancelDirectBooking).not.toHaveBeenCalled();
  });

  it("refuses a misspelt reason with 400 and cancels nothing, rather than an ordinary cancel", async () => {
    const res = await viaPost({ ...REGAL_OPT_OUT_BODY, reason: "text_optout" });
    expect(res.status).toBe(400);
    expect(service.cancelDirectBooking).not.toHaveBeenCalled();
  });
});

// #2940, as rebuilt on 2026-10-01: Marcia (Pennie's Pipedream SMS workflow) cancels the
// Slate booking itself, beside its cal.com cancel, on its OWN key. These are the two
// bodies its Pipedream code step sends, field for field (the opt out path and the
// cancel request path differ only by the reason), so a rename of any field here
// breaks this test rather than Marcia's next real opt out.
describe("POST /api/bookings/cancel on Marcia's own key (#2940)", () => {
  const MARCIA_KEY = "marcia-secret";
  const MARCIA_OPT_OUT_BODY = {
    bookingId: "5f14aac7-ad33-4b8c-98cd-5fc5f5d7babc",
    salesforceId: "00QUi0000108JOMMA2",
    reason: "text_opt_out",
  };
  const MARCIA_CANCEL_REQUEST_BODY = {
    bookingId: "5f14aac7-ad33-4b8c-98cd-5fc5f5d7babc",
    salesforceId: "00QUi0000108JOMMA2",
    reason: "other",
    reasonDetail: "Asked Marcia by text to cancel",
  };
  const marciaKeyFor = (marcia: string) => (caller: string, slot: string) =>
    caller === "regal" && slot === "primary" ? "real-secret" : caller === "marcia" && slot === "primary" ? marcia : "";

  beforeEach(async () => {
    env.bookingApiKeyFor.mockImplementation(marciaKeyFor(MARCIA_KEY));
    service.bookViaApi.mockReset();
    service.previewBooking.mockReset();
    service.lookupPersonBookings.mockReset();
    service.getPersonBookingById.mockReset();
    service.listBookings.mockReset();
    const real = await vi.importActual<typeof import("@/lib/booking/reason-options")>(
      "@/lib/booking/reason-options",
    );
    reasons.loadReasonOptions.mockResolvedValue(
      real.resolveReasonOptions([
        { action: "cancel", code: "no_longer_interested", label: "No longer interested", sort_order: 0, active: true, locked: false, system_only: false },
        { action: "cancel", code: "other", label: "Other", sort_order: 1, active: true, locked: true, system_only: false },
      ]),
    );
  });

  afterEach(() => {
    env.bookingApiKeyFor.mockImplementation((caller: string, slot: string) =>
      caller !== "regal" ? "" : slot === "primary" ? regalKey.primary() : regalKey.secondary(),
    );
  });

  it("cancels on the opt out path, recorded as an opt out by text", async () => {
    const res = await viaPost(MARCIA_OPT_OUT_BODY, `Bearer ${MARCIA_KEY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "cancelled", booking: VIEW });
    expect(service.cancelDirectBooking).toHaveBeenCalledExactlyOnceWith({
      bookingId: MARCIA_OPT_OUT_BODY.bookingId,
      identity: { externalId: null, salesforceId: MARCIA_OPT_OUT_BODY.salesforceId },
      reason: { code: "text_opt_out", detail: null },
    });
  });

  it("cancels on the cancel request path, as other with Marcia's detail", async () => {
    const res = await viaPost(MARCIA_CANCEL_REQUEST_BODY, `Bearer ${MARCIA_KEY}`);
    expect(res.status).toBe(200);
    expect(service.cancelDirectBooking).toHaveBeenCalledExactlyOnceWith({
      bookingId: MARCIA_CANCEL_REQUEST_BODY.bookingId,
      identity: { externalId: null, salesforceId: MARCIA_CANCEL_REQUEST_BODY.salesforceId },
      reason: { code: "other", detail: "Asked Marcia by text to cancel" },
    });
  });

  it("answers 404 NOT_FOUND for a booking already cancelled, which Marcia reads as a skip", async () => {
    service.cancelDirectBooking.mockRejectedValue(new service.BookingNotFoundError("Booking not found"));
    const res = await viaPost(MARCIA_OPT_OUT_BODY, `Bearer ${MARCIA_KEY}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Booking not found", code: "NOT_FOUND" });
  });

  it("refuses Marcia with 401 while her key is unset, and Regal still cancels", async () => {
    env.bookingApiKeyFor.mockImplementation(marciaKeyFor(""));
    const refused = await viaPost(MARCIA_OPT_OUT_BODY, `Bearer ${MARCIA_KEY}`);
    expect(refused.status).toBe(401);
    expect(service.cancelDirectBooking).not.toHaveBeenCalled();
    const regal = await viaPost(MARCIA_OPT_OUT_BODY, "Bearer real-secret");
    expect(regal.status).toBe(200);
  });

  it("may cancel through DELETE /api/bookings too, the same cancel", async () => {
    const res = await viaDelete(MARCIA_OPT_OUT_BODY, `Bearer ${MARCIA_KEY}`);
    expect(res.status).toBe(200);
    expect(service.cancelDirectBooking).toHaveBeenCalledTimes(1);
  });

  it("may NOT book with her key: POST /api/bookings refuses it and books nothing", async () => {
    const res = await BOOK(
      new Request("http://localhost/api/bookings", {
        method: "POST",
        headers: { authorization: `Bearer ${MARCIA_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ bucketCode: "411", start: "2026-10-02T15:00:00Z", salesforceId: "00QUi0000108JOMMA2" }),
      }) as never,
    );
    expect(res.status).toBe(401);
    expect(service.bookViaApi).not.toHaveBeenCalled();
    expect(service.previewBooking).not.toHaveBeenCalled();
  });

  it("may NOT read bookings with her key: GET /api/bookings refuses it", async () => {
    const url = new URL("http://localhost/api/bookings?salesforceId=00QUi0000108JOMMA2");
    const req = Object.assign(new Request(url, { headers: { authorization: `Bearer ${MARCIA_KEY}` } }), { nextUrl: url });
    const res = await LOOKUP(req as never);
    expect(res.status).toBe(401);
    expect(service.lookupPersonBookings).not.toHaveBeenCalled();
    expect(service.listBookings).not.toHaveBeenCalled();
  });
});

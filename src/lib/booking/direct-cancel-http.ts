import { NextResponse, type NextRequest } from "next/server";
import { authorizeBookingApi } from "@/lib/booking/route-auth";
import { BOOKING_API_CALLERS } from "@/lib/booking/api-auth";
import {
  DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
} from "@/lib/rate-limit-core";
import type { CancelParseResult } from "@/lib/booking/api-request";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import type { ReasonOption } from "@/lib/booking/core";
import { cancelDirectBooking, BookingNotFoundError } from "@/lib/booking/service";
import { isBookingWriteFailure } from "@/lib/booking/gated-write";
import { GENERIC_ERROR_MESSAGE, reportInternalError } from "@/lib/api/errors";
import { isTestOwnedBookingForPaging } from "@/lib/monitor/test-traffic";

/**
 * The key authed cancel, once (#386, #2591). `DELETE /api/bookings` carries its fields
 * in the query and `POST /api/bookings/cancel` carries them in a JSON body, because a
 * Regal journey's webhook step cannot send DELETE. Everything that decides who may
 * call, whose booking may be touched and what each ending answers lives here, so the
 * two verbs differ only in where the fields are read from.
 *
 * Who may call: a holder of any booking API caller key, the cancel only ones (Marcia,
 * #2940) included, under the same ceilings as every other write on that key. Whose booking: only one owned by the strong id the caller sends
 * (`cancelDirectBooking` checks ownership and answers not found otherwise).
 *
 * `readFields` runs only AFTER the key is accepted, so an unauthenticated body is
 * never parsed as an instruction.
 */
export async function respondToDirectCancel(
  req: NextRequest,
  readFields: (allowedCancel: ReasonOption[]) => CancelParseResult | Promise<CancelParseResult>,
): Promise<NextResponse> {
  // #2940: the one route a cancel only caller (Marcia) may reach, so it admits every
  // caller rather than the whole API default.
  const authd = await authorizeBookingApi(
    req,
    DIRECT_BOOKING_API_HOURLY_RATE_RULES,
    DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
    false,
    BOOKING_API_CALLERS,
  );
  if (!authd.ok) return authd.response;

  const reasonOptions = await loadReasonOptions();
  const parsed = await readFields(reasonOptions.cancel.all);
  if (!parsed.ok) {
    // refusal: api_query_invalid
    return NextResponse.json({ error: parsed.error, code: "VALIDATION" }, { status: 400 });
  }
  const { bookingId, externalId, salesforceId, reason } = parsed.value;

  try {
    const booking = await cancelDirectBooking({
      bookingId,
      identity: { externalId, salesforceId },
      reason,
    });
    return NextResponse.json({ outcome: "cancelled", booking });
  } catch (err) {
    const { httpStatus, code } = mapLookupError(err);
    // #3580: the smoke canary cancels its own test bookings through this (bot) path,
    // so an INTERNAL fault here paged production. Resolve test-ness only from the
    // (bookingId, externalId) PAIR naming one owned booking, so neither half is
    // caller-settable. A caller naming only a salesforceId (no externalId) cannot be
    // the canary (which uses externalId), so it pages. Only on INTERNAL.
    const isTest =
      code === "INTERNAL" && bookingId && externalId
        ? await isTestOwnedBookingForPaging(bookingId, externalId)
        : false;
    return NextResponse.json(await apiErrorBody(err, code, "cancel", "Cancel failed", { isTest }), {
      status: httpStatus,
    });
  }
}

/**
 * Body for a mapped error. A typed code keeps its own intended, safe message
 * (validation text, "no eligible agents", "slot taken") that the bot acts on;
 * an unexpected INTERNAL returns the generic message and logs the real detail
 * server-side so table names / Google error text never leak to the client
 * (#707, sibling of #598). The machine-readable `code` is always preserved.
 *
 * An INTERNAL here goes through the SAME chokepoint as every other unexpected
 * fault (`reportInternalError`, #802), so the bot API alerts too. It used to
 * only `console.error`, which meant the one caller that is a machine, and so has
 * nobody watching its responses, was also the one whose faults nobody heard.
 */
export async function apiErrorBody(
  err: unknown,
  code: string,
  context: string,
  fallback: string,
  // #3575: when the attempt is test traffic (the smoke canary on an `is_test`
  // bucket) the INTERNAL fault is still logged in full but does not PAGE the
  // production incident channel. Omitted or false means a real fault, which pages
  // exactly as before; the caller resolves test-ness from the bucket (server-only,
  // via resolveTestTraffic) so a client can never set it.
  opts: { isTest?: boolean } = {},
): Promise<{ error: string; code: string }> {
  if (code === "INTERNAL") {
    await reportInternalError(err, `bookings-api/${context}`, { page: !opts.isTest });
    return { error: GENERIC_ERROR_MESSAGE, code };
  }
  return { error: err instanceof Error ? err.message : fallback, code };
}

/** Error→code map for the lookup/cancel paths (#386): a missing/unowned booking
 *  is NOT_FOUND; anything else is an unexpected INTERNAL. */
export function mapLookupError(err: unknown): {
  httpStatus: number;
  code: "NOT_FOUND" | "WRITE_FAILED" | "INTERNAL";
} {
  if (err instanceof BookingNotFoundError) return { httpStatus: 404, code: "NOT_FOUND" };
  // #2373: the cancel claim did not RUN, so the booking still stands. A bot reads
  // INTERNAL as an unexpected fault to escalate and 404 as "already gone", and both
  // are wrong here: nothing happened and a retry really can succeed. Its own code,
  // because the instruction differs from every other ending on this path.
  if (isBookingWriteFailure(err)) return { httpStatus: 503, code: "WRITE_FAILED" };
  return { httpStatus: 500, code: "INTERNAL" };
}

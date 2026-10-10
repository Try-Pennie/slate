import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { cancelBooking, BookingNotCancellableError } from "@/lib/booking/service";
import { validateReason } from "@/lib/booking/core";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { isBookingWriteFailure } from "@/lib/booking/gated-write";
import { recordApiOutcome } from "@/lib/monitor/record-api-outcome";
import { internalErrorResponse, reportInternalError } from "@/lib/api/errors";
import { isTestManageTokenForPaging } from "@/lib/monitor/test-traffic";
import { noStore } from "@/lib/api/no-store";
import { manageWithinLimit } from "@/lib/rate-limit";
// From the pure core rather than the re-export, so a test can stub the limiter without
// also having to hand back a working clientIp.
import { clientIp } from "@/lib/rate-limit-core";
import { readJsonCapped, PUBLIC_JSON_MAX_BYTES } from "@/lib/http/read-json-capped";

export const dynamic = "force-dynamic";

const schema = z.object({
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
});

/**
 * #2561: one wrapper rather than a header on each of the returns below. Every
 * ending of this handler, the confirmations and the refusals alike, describes one
 * lead's request at one moment, and a return added later carries the directive by
 * construction instead of by somebody remembering (L96).
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  return noStore(await handlePost(req, ctx));
}

async function handlePost(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  // #1046: bound what an unauthenticated caller costs us. Guessing a manage token is
  // infeasible, so this is not about getting in; it is about a garbage token buying a
  // database round trip per request with nothing counting them. Fails OPEN, so a
  // limiter hiccup can never stop a real customer cancelling.
  if (!(await manageWithinLimit(clientIp(req.headers)))) {
    // refusal: cancel_rate_limited
    return NextResponse.json(
      { error: "Too many requests. Please try again in a moment." },
      { status: 429 },
    );
  }

  const { token } = await params;
  // #3135: read under a byte cap rather than buffering whatever arrives.
  const read = await readJsonCapped(req, PUBLIC_JSON_MAX_BYTES);
  if (read.tooLarge) {
    // refusal: cancel_body_too_large
    return NextResponse.json({ error: "Request too large" }, { status: 413 });
  }
  const parsed = schema.safeParse(read.value ?? {});
  if (!parsed.success) {
    // refusal: cancel_invalid_request
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Reason is mandatory (#326), server-enforced, not just in the UI. Validate
  // against the live option set (active + retired, #346).
  const reasonOptions = await loadReasonOptions();
  const reason = validateReason(
    { code: parsed.data.reason, detail: parsed.data.reasonDetail },
    reasonOptions.cancel.selectable,
  );
  if (!reason.ok) {
    // refusal: cancel_invalid_reason
    return NextResponse.json({ error: reason.error }, { status: 400 });
  }

  try {
    const { claimed, booking } = await cancelBooking(token, reason.reason, "customer");
    // #2373: the two ways this ends with the booking cancelled, counted apart.
    //
    // `claimed` is true when THIS request made the transition and false when a
    // concurrent cancel or completion already had. The lead is told the same thing
    // either way, because it is true either way: their call is off. What differs is
    // what a RUN of the second one means, which is something terminating bookings
    // underneath their owners, and nothing else in Slate would see it.
    //
    // The success is recorded alongside the refusals below so the share stays a
    // share: counting only the failures would inflate the very number the
    // booking-failure window pages on.
    if (claimed) {
      recordApiOutcome("cancelled", "", null, { by: "manageToken", token });
    } else {
      // refusal: cancel_lost_race
      recordApiOutcome("error", "", "cancel_lost_race", { by: "manageToken", token });
    }
    // #2658: which call, so the embedded booker can announce the cancel to its
    // host page as cal.com's `bookingCancelled` with the booking's id and bounds.
    // Id and times only: this reaches the lead's browser and, from there, a host
    // page, and the host already holds the contact.
    return NextResponse.json({ ok: true, booking });
  } catch (err) {
    // The meeting already completed (#618): a friendly 4xx no-op, not a crash.
    if (err instanceof BookingNotCancellableError) {
      // refusal: cancel_not_cancellable
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // #2373: the gated write did not RUN, so nothing is cancelled. This used to be
    // indistinguishable from losing the claim, and the answer was `{ ok: true }`:
    // the lead read that their call was cancelled while the booking, the invite and
    // the advisor's slot all stood. It is reported through the same chokepoint an
    // unexpected fault goes through, so somebody is paged, and answered 503 rather
    // than 500 because a retry really can succeed.
    // #3580: the smoke canary cancels its own test bookings on this path, so an
    // INTERNAL fault here paged the production incident channel. Resolve test-ness
    // from the booking's bucket (server-side, via the manage token) and withhold the
    // page for test traffic; a real one still pages (an unreadable marker pages).
    const page = !(await isTestManageTokenForPaging(token));
    if (isBookingWriteFailure(err)) {
      recordApiOutcome("error", "", "cancel_write_failed", { by: "manageToken", token });
      await reportInternalError(err, "bookings/[token]/cancel", { page });
      // refusal: cancel_write_failed
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    recordApiOutcome("error", "", "cancel_internal", { by: "manageToken", token });
    // refusal: cancel_internal
    return internalErrorResponse(err, "bookings/[token]/cancel", { page });
  }
}

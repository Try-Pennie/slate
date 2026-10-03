import { NextResponse, type NextRequest } from "next/server";
import { refuseCredential } from "@/lib/bearer-failure";
import { duplicateCancelApiKey, duplicateCancelApiKey2 } from "@/lib/env";
import { bearerTokenMatches } from "@/lib/bearer-auth";
import { cancelDuplicateBooking } from "@/lib/booking/service";
import {
  DUPLICATE_CANCEL_CODE,
  DUPLICATE_CANCEL_MESSAGE,
  DUPLICATE_CANCEL_STATUS,
  DuplicateCancelUnavailableError,
  duplicateFindingFor,
} from "@/lib/booking/duplicate-cancel";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Cancel a lead's EARLIER call, and only when Slate can establish it is a duplicate
 * (#2369, #2307 phase 3).
 *
 * This replaces two Pipedream flows that cancel the named cal.com booking outright,
 * with no check that the lead has another call at all. Regal names the same booking
 * here; Slate decides. Everything that decides lives in one database function
 * (migration 0124), so the check and the cancel cannot be separated by a crash and
 * leave somebody with no call.
 *
 *   POST (Bearer DUPLICATE_CANCEL_API_KEY) { bookingId, laterBookingStartsAt? }
 *     200  cancelled | already-cancelled
 *     400  the body named no booking
 *     401  wrong key         503  no key configured
 *     409  a refusal, naming what Slate measured
 *     503  nothing was decided, or the finding could not be recorded: RETRY
 *
 * A retry after a success is a success: a booking already cancelled AS a duplicate
 * answers 200, so a journey that never saw the first reply is not told it failed.
 */
export async function POST(req: NextRequest) {
  const key = duplicateCancelApiKey();
  if (!key) {
    return NextResponse.json(
      { error: "duplicate cancel api not configured", code: "NOT_CONFIGURED" },
      { status: 503 },
    );
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), [key, duplicateCancelApiKey2()])) {
    return refuseCredential(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }

  const body = (await req.json().catch(() => ({}))) as {
    bookingId?: unknown;
    laterBookingStartsAt?: unknown;
  };
  const bookingId = typeof body.bookingId === "string" ? body.bookingId.trim() : "";
  if (!bookingId) {
    return NextResponse.json({ error: "bookingId is required", code: "VALIDATION" }, { status: 400 });
  }
  // Recorded on the handoff exactly as sent, so a person reading the notice sees what
  // the caller claimed rather than something Slate derived. Never parsed into an
  // instant here: a value Slate cannot read is still worth showing, and the notice
  // builder is what decides whether it can render it.
  const laterBookingStartsAt =
    typeof body.laterBookingStartsAt === "string" && body.laterBookingStartsAt.trim()
      ? body.laterBookingStartsAt.trim()
      : null;

  try {
    const { result, handoff, delivered } = await cancelDuplicateBooking({
      bookingId,
      laterBookingStartsAt,
    });
    const status = DUPLICATE_CANCEL_STATUS[result.outcome];
    log.info("duplicate-cancel", {
      msg: "outcome",
      booking_id: bookingId,
      outcome: result.outcome,
      status,
      handoff: handoff ?? "none",
      delivered: delivered === null ? "deferred" : String(delivered),
    });
    return NextResponse.json(
      {
        outcome: result.outcome,
        code: DUPLICATE_CANCEL_CODE[result.outcome],
        message: DUPLICATE_CANCEL_MESSAGE[result.outcome],
        // Present only on a refusal somebody has to act on, and then it says whether
        // THIS call opened the record or found one already open, so a retried journey
        // reads as the same refusal rather than a new one.
        ...(duplicateFindingFor(result.outcome)
          ? { finding: duplicateFindingFor(result.outcome), handoff, weakerMatch: result.weakerMatch }
          : {}),
      },
      { status },
    );
  } catch (err) {
    if (err instanceof DuplicateCancelUnavailableError) {
      log.error(
        "duplicate-cancel",
        { msg: "incomplete", booking_id: bookingId, stage: err.stage },
        err,
      );
      // FAILS CLOSED. Nothing was decided, or the decision could not be handed to
      // anybody, and either way the caller must come back rather than read an outage
      // as Slate declining to cancel (L11).
      return NextResponse.json(
        {
          error: "The duplicate check could not be completed. Please retry.",
          code: "DUPLICATE_CHECK_UNAVAILABLE",
          stage: err.stage,
        },
        { status: 503 },
      );
    }
    log.error(
      "duplicate-cancel",
      { msg: "unexpected failure", booking_id: bookingId },
      err instanceof Error ? err : new Error(String(err)),
    );
    return NextResponse.json(
      {
        error: "The duplicate check could not be completed. Please retry.",
        code: "DUPLICATE_CHECK_UNAVAILABLE",
        stage: "rpc",
      },
      { status: 503 },
    );
  }
}

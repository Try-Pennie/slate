import { NextResponse, type NextRequest } from "next/server";
import { refuseCredential } from "@/lib/bearer-failure";
import { reassignApiKey, reassignApiKey2 } from "@/lib/env";
import { bearerTokenMatches } from "@/lib/bearer-auth";
import { reassignBooking } from "@/lib/booking/service";
import { mapReassignError } from "@/lib/booking/reassign-http";
import { validateReason, type ValidatedReason } from "@/lib/booking/core";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { sendThrottledInfo } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";
import { unknownReasonCodeNotice } from "@/lib/notify/misc-alert-copy";

/** Throttle window for the unknown-reason-code visibility alert (#993): a
 *  persistent misconfiguration nudges once an hour, never per call. */
const UNKNOWN_REASON_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

export const dynamic = "force-dynamic";

/**
 * Agent-reassign API (#9). An upstream automation that owns the
 * contact-stickiness decision calls this to force a booking onto a specific
 * owning advisor — even if that advisor is busy (the one place double-booking
 * is allowed). Bearer-authed with REASSIGN_API_KEY since it mutates and moves
 * calendar events.
 *
 *   POST { bookingId, agentEmail } -> 200 { booking, overCap } | 404 | 409 | 401/503
 */
export async function POST(req: NextRequest) {
  const key = reassignApiKey();
  if (!key) {
    return NextResponse.json({ error: "reassign api not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), [key, reassignApiKey2()])) {
    return refuseCredential(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }

  const body = (await req.json().catch(() => ({}))) as {
    bookingId?: string;
    agentEmail?: string;
    reasonCode?: string;
    reasonDetail?: string;
  };
  const bookingId = String(body.bookingId ?? "").trim();
  const agentEmail = String(body.agentEmail ?? "").trim();
  if (!bookingId || !agentEmail) {
    return NextResponse.json({ error: "bookingId and agentEmail are required" }, { status: 400 });
  }

  // Machine-to-machine path: the reason isn't picked from the customer lists, so
  // it's validated against the SAME live store the six interactive sites use
  // (#346/#988). An empty code is the normal "use the default" case (the
  // contact-owner override). A supplied code is validated so a typo'd or retired
  // code can't quietly enter booking_events; validation also discards stray detail
  // on non-"other" codes and enforces the detail cap. Because the reassign itself
  // is the critical operation (the one place an owner override forces a
  // double-book), an unknown code must NOT fail the move: it normalizes to the
  // default and logs the anomaly (fail-loud in logs), rather than returning 400.
  const rawCode = String(body.reasonCode ?? "").trim();
  const rawDetail = String(body.reasonDetail ?? "").trim().slice(0, 500) || null;
  const reasonOptions = await loadReasonOptions();
  const validated = validateReason(
    { code: rawCode || "owner_reassignment", detail: rawDetail },
    reasonOptions.reassign.all,
  );
  let reason: ValidatedReason;
  if (validated.ok) {
    reason = validated.reason;
  } else {
    log.warn("reassign", {
      msg: "unknown reassign reason code; recorded owner_reassignment instead",
      received: rawCode,
    });
    reason = { code: "owner_reassignment", detail: null };
    // Surface a persistent integration bug beyond the 7-day logs (#993): a
    // visibility-only, throttled Slack nudge. Best-effort: a failed send must
    // never fail the reassign, which is the critical operation here.
    await sendThrottledInfo(
      "reassign-unknown-reason-code",
      UNKNOWN_REASON_ALERT_COOLDOWN_MS,
      unknownReasonCodeNotice(rawCode),
    ).catch((err) => {
      log.error("reassign", { msg: "unknown-reason alert send failed" }, err instanceof Error ? err : err);
    });
  }

  try {
    const result = await reassignBooking(bookingId, agentEmail, reason, true);
    if (result.overCap) {
      log.warn("reassign", {
        msg: "forced agent over their daily cap",
        agent: result.booking.agent_email,
        booking_id: result.booking.id,
      });
    }
    return NextResponse.json({
      booking: {
        id: result.booking.id,
        assignedUserId: result.booking.assigned_user_id,
        agentEmail: result.booking.agent_email,
        startsAt: result.booking.starts_at,
        status: result.booking.status,
      },
      overCap: result.overCap,
    });
  } catch (err) {
    return mapReassignError(err, "bookings/reassign");
  }
}

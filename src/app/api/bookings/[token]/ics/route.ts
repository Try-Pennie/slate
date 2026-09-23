import type { NextRequest } from "next/server";
import { bookingIcs, getBookingByToken } from "@/lib/booking/service";
import { CALENDAR_COPY } from "@/lib/booking/booker-copy";
import { internalErrorResponse } from "@/lib/api/errors";
import { manageWithinLimit } from "@/lib/rate-limit";
// From the pure core rather than the re-export, so a test can stub the limiter without
// also having to hand back a working clientIp.
import { clientIp } from "@/lib/rate-limit-core";

export const dynamic = "force-dynamic";

/**
 * The add to calendar file for one booking (#2643).
 *
 * Authorised by the manage token in the path, like reschedule, cancel and phone
 * beside it, so the "Apple / ICS" button on trypennie's booking confirmed page can
 * be a plain link: a key authed caller cannot hand a browser its key. It is read
 * only, and it shows nothing the manage page for the same token does not.
 *
 * Built when it is asked for rather than when the booking was made, so a call that
 * has moved since downloads at its current time, and never cached for the same
 * reason. A cancelled call gets no file: adding a meeting that is off to somebody's
 * calendar is worse than telling them it is off.
 */
function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  // #1046: bound what a garbage token costs us, exactly as the manage writes do.
  if (!(await manageWithinLimit(clientIp(req.headers)))) {
    // refusal: manage_ics_throttled
    return text("Too many requests. Please try again in a moment.", 429);
  }

  const { token } = await params;
  try {
    const ctx = await getBookingByToken(token);
    if (!ctx) {
      // refusal: manage_ics_not_found
      return text(CALENDAR_COPY.icsNotFound, 404);
    }
    if (ctx.booking.status === "cancelled") {
      // refusal: manage_ics_cancelled
      return text(CALENDAR_COPY.icsCancelled, 410);
    }
    return new Response(bookingIcs(ctx.booking, new Date().toISOString()), {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'attachment; filename="pennie-call.ics"',
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return internalErrorResponse(err, "manage-ics");
  }
}

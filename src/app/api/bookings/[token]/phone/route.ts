import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { updateBookingPhone } from "@/lib/booking/service";
import { INPUT_LIMITS } from "@/lib/booking/input-limits";
import { internalErrorResponse } from "@/lib/api/errors";
import { manageWithinLimit } from "@/lib/rate-limit";
// From the pure core rather than the re-export, so a test can stub the limiter without
// also having to hand back a working clientIp.
import { clientIp } from "@/lib/rate-limit-core";
import { readJsonCapped, PUBLIC_JSON_MAX_BYTES } from "@/lib/http/read-json-capped";

export const dynamic = "force-dynamic";

/**
 * A lead corrects the number their advisor will call (#1341).
 *
 * Authorised by the manage token in the path, exactly like reschedule and cancel
 * beside it: this is a scoped edit of ONE field on a booking that token already
 * governs, not a new identity surface, so it needs no new auth and can reach
 * nothing else on the row.
 *
 * The shape check here is only a ceiling: a multi-MB blob is refused before it
 * reaches Postgres or a Google event body (#1034). Whether the number is one we
 * can actually call is decided by the shared attendee rule inside the service,
 * so this route can never become a second, laxer opinion about a phone number.
 */
const schema = z.object({
  phone: z.string().max(INPUT_LIMITS.contact),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  // #1046: bound what an unauthenticated caller costs us. Guessing a manage token is
  // infeasible, so this is not about getting in; it is about a garbage token buying a
  // database round trip per request with nothing counting them. Fails OPEN, so a
  // limiter hiccup can never stop a real customer correcting their number.
  if (!(await manageWithinLimit(clientIp(req.headers)))) {
    return NextResponse.json(
      { error: "Too many requests. Please try again in a moment." },
      { status: 429 },
    );
  }

  const { token } = await params;
  // #3135: read under a byte cap rather than buffering whatever arrives.
  const read = await readJsonCapped(req, PUBLIC_JSON_MAX_BYTES);
  if (read.tooLarge) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  const parsed = schema.safeParse(read.value);
  if (!parsed.success) {
    // refusal: manage_phone_invalid_request
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const res = await updateBookingPhone(token, parsed.data.phone);
    if (!res.ok) {
      // refusal: manage_phone_refused
      // The service's own lead-facing sentence, not a generic one: a number we
      // cannot call, an incomplete number, an unknown link and a call that has
      // already happened are four different things to a reader (L11).
      return NextResponse.json({ error: res.error }, { status: 400 });
    }
    // The STORED number, so the page renders what was saved rather than what was
    // typed. A save that did not commit never reaches here: the write throws.
    return NextResponse.json({ phone: res.phone });
  } catch (err) {
    return internalErrorResponse(err, "manage-phone");
  }
}

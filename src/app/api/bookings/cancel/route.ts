import type { NextRequest } from "next/server";
import { parseCancelBody } from "@/lib/booking/api-request";
import { respondToDirectCancel } from "@/lib/booking/direct-cancel-http";

export const dynamic = "force-dynamic";

/**
 * Cancel one booking by id, fields in a JSON body (#2591). The same cancel as
 * `DELETE /api/bookings`, for a caller that cannot send DELETE: a Regal journey's
 * webhook step offers GET, POST, PUT and PATCH only. Auth, ownership and every
 * ending are `respondToDirectCancel`'s, shared with the DELETE form.
 *
 *   POST (Bearer a caller's own key, BOOKING_API_KEY_<CALLER>[_2]) -> 200 | 400 | 401 | 404 | 429 | 500 | 503
 */
export async function POST(req: NextRequest) {
  return respondToDirectCancel(req, async (allowedCancel) =>
    parseCancelBody(await req.json().catch(() => null), allowedCancel),
  );
}

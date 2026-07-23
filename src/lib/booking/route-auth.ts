import { NextResponse, type NextRequest } from "next/server";
import { bookingApiKeyPrimary, bookingApiKeySecondary } from "@/lib/env";
import { parseApiKeys, authenticateBearer } from "@/lib/booking/api-auth";
import {
  allowRequest,
  clientIp,
  bookingApiWriteWithinLimit,
  bookingApiReadWithinLimit,
  bookingApiIpWithinLimit,
} from "@/lib/rate-limit";
import {
  DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
} from "@/lib/rate-limit-core";
import type { RateLimitRule } from "@/lib/rate-limit-core";

export type AuthOutcome =
  | { ok: true; keyId: "primary" | "secondary" }
  | { ok: false; response: NextResponse };

/**
 * Shared bearer-auth + rate-limit gate for the key-authed booking API routes
 * (#386, extracted in #1017 so `/api/bookings` and `/api/bookings/bookable` share
 * one gate instead of drifting copies). The per-minute burst windows run at the
 * Cloudflare edge (#961, no DB round-trip); the strict hourly ceilings stay in the
 * DB. `hourlyKeyRules` selects the ceiling (writes use the default; reads pass a
 * separate ceiling so polling can't starve the booking path, #393). `readPath`
 * picks the matching edge binding, and a null `hourlyIpRules` opts reads out of
 * the per-IP backstop.
 */
export async function authorizeBookingApi(
  req: NextRequest,
  hourlyKeyRules: RateLimitRule[] = DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  hourlyIpRules: RateLimitRule[] | null = DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
  readPath = false,
): Promise<AuthOutcome> {
  const keys = parseApiKeys(bookingApiKeyPrimary(), bookingApiKeySecondary());
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return { ok: false, response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  }
  const keyBudget = "Rate limit exceeded for this API key.";
  // Per-key: edge per-minute burst window first (no DB round-trip), then the hourly cap.
  const keyEdgeOk = readPath
    ? await bookingApiReadWithinLimit(auth.keyId)
    : await bookingApiWriteWithinLimit(auth.keyId);
  if (!keyEdgeOk || !(await allowRequest(`key:${auth.keyId}`, hourlyKeyRules))) {
    return {
      ok: false,
      response: NextResponse.json({ error: keyBudget }, { status: 429 }),
    };
  }
  // #597: a coarse per-IP backstop on top of the per-key ceiling, in its own counter.
  // The key ceiling bounds total volume; this bounds any ONE machine, so a leaked key
  // cannot spend the whole budget from a single host. Per-minute at the edge, hourly in DB.
  if (hourlyIpRules) {
    const ip = clientIp(req.headers);
    if (!(await bookingApiIpWithinLimit(ip)) || !(await allowRequest(`ip:${ip}`, hourlyIpRules))) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Rate limit exceeded for this client." },
          { status: 429 },
        ),
      };
    }
  }
  return { ok: true, keyId: auth.keyId };
}

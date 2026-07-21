import { NextResponse, type NextRequest } from "next/server";
import { bookingApiKeyPrimary, bookingApiKeySecondary } from "@/lib/env";
import { parseApiKeys, authenticateBearer } from "@/lib/booking/api-auth";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";

export const dynamic = "force-dynamic";

/**
 * Liveness stamp for the scheduled booking-smoke canary (#525). The canary
 * (`.github/workflows/smoke-canary.yml`) calls this on every successful run, so
 * if the schedule silently stops firing (or starts failing before it reports),
 * the `smoke-canary` heartbeat goes stale and the lane-watchdog pages
 * (CANARY_STALE_BOUNDS_MS). It is NOT a Worker cron lane and is deliberately kept
 * out of the external /api/health signal, so a dead canary never reads as the app
 * being down.
 *
 * Auth reuses the booking-API Bearer key: the caller is the same trusted smoke
 * run that already holds it, so no new secret. Fails CLOSED (503) when no key is
 * configured; 401 for a wrong or missing key. The only side effect is upserting
 * the single `smoke-canary` heartbeat row.
 */
export async function POST(req: NextRequest) {
  const keys = parseApiKeys(bookingApiKeyPrimary(), bookingApiKeySecondary());
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  await recordHeartbeat("smoke-canary");
  return NextResponse.json({ ok: true });
}

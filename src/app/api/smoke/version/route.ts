import { NextResponse, type NextRequest } from "next/server";
import { bookingApiKeyPrimary, bookingApiKeySecondary } from "@/lib/env";
import { parseApiKeys, authenticateBearer } from "@/lib/booking/api-auth";
import { BUILD_COMMIT } from "@/lib/build-info";
import { isLoadtest } from "@/lib/loadtest-guard";
import { LOADTEST_FAULT_PCT } from "@/lib/google/loadtest-stub";

export const dynamic = "force-dynamic";

/**
 * Which commit the live Worker is serving (#1037), for the post-deploy probe.
 *
 * The probe polls this after `cf:deploy` and refuses to judge the app's health
 * until the expected commit answers. Without it, a probe hitting `/api/health`
 * during Cloudflare's propagation window gets a 200 from the PREVIOUS version and
 * reports a broken deploy as healthy.
 *
 * KEY-AUTHED, and that is a deliberate choice rather than caution for its own
 * sake: publishing the running commit on an unauthenticated endpoint tells anyone
 * probing the app exactly which build is live, and therefore which known issues to
 * try. The deploy job already holds the booking key (it is a repo secret for the
 * smoke canary), so gating this costs nothing operationally. Same trust level and
 * same failure modes as `/api/smoke/heartbeat`: fails CLOSED with a 503 when no key
 * is configured, 401 for a wrong or missing key.
 *
 * Deliberately NOT part of `/api/health`, which is the unauthenticated external
 * liveness signal and must stay minimal and safe to expose.
 */
export async function GET(req: NextRequest) {
  const keys = parseApiKeys(bookingApiKeyPrimary(), bookingApiKeySecondary());
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  // `loadtest` comes from the same predicate every stub and refusal keys on
  // (`@/lib/loadtest-guard`), never from a second read of the variable, so this
  // cannot report a mode the rest of the deployment is not in (L70). It is what
  // lets the load run's preflight establish, before it drives anything, that the
  // deployment it is about to send six hundred bookings at really is stubbing
  // Google rather than creating six hundred real calendar events.
  // `faultPct` is the SAME constant the stub injects faults from, imported rather
  // than re-read from the variable beside it (#2262, L70). A second read could
  // report a percentage the stub is not using, and the whole value of reporting it
  // is that the load run's fault leg can establish, before it sends anything, that
  // the deployment really is faulting: a deployment running zero answers every
  // request perfectly and would satisfy the "no 5xx under fault" bar with no fault
  // ever injected (L98).
  return NextResponse.json({
    commit: BUILD_COMMIT,
    loadtest: isLoadtest(),
    faultPct: LOADTEST_FAULT_PCT,
  });
}

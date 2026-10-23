import { NextResponse, type NextRequest } from "next/server";
import { refuseBearerAuth } from "@/lib/bearer-failure";
import { authenticateBearer, CANARY_CALLERS } from "@/lib/booking/api-auth";
import { configuredBookingApiKeys } from "@/lib/booking/api-keys";
import { releaseTestAdvisorLease, takeTestAdvisorLease } from "@/lib/booking/test-advisor-lease";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * The smoke canary's handle on the one lease over the two smoke test advisors (#4180).
 *
 * The canary's full pass and the daily reroute drill both book on those advisors, and when they
 * overlapped on 2026-10-23 both failed. The drill's endpoint takes the lease itself; the canary's
 * booking spans two workflow steps, so it takes the lease here before them and hands it back here
 * after (`scripts/smoke-test-advisor-lease.ts`).
 *
 * WHO MAY CALL IT: the canary's own Bearer key, the same contract as its `/api/smoke` siblings:
 * 503 when none is configured, 401 for any other key, a partner's included.
 *
 * WHAT IT MAY TOUCH: the one `sync_locks` row the lease key names, fixed in code. Nothing in the
 * request chooses the key or the TTL.
 *
 *   POST     takes the lease: `{ outcome: "held", token }`, or `{ outcome: "busy" }` while another
 *            run holds it. The caller asks again; this never waits.
 *   DELETE   `{ token }` releases that claim: `released`, or `not-held` when no claim of that
 *            token remains (released already, or taken over after the TTL), so a second release
 *            is harmless. A release the database refused answers 500 `refused`; the TTL frees the
 *            lease regardless.
 */
export async function POST(req: NextRequest) {
  const keys = configuredBookingApiKeys(CANARY_CALLERS);
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return refuseBearerAuth(req.headers, auth);
  }
  try {
    const token = await takeTestAdvisorLease();
    return NextResponse.json(token === null ? { outcome: "busy" } : { outcome: "held", token });
  } catch (err) {
    log.error("test-advisor-lease", { msg: "the lease could not be taken" }, err);
    return NextResponse.json({ outcome: "errored" }, { status: 500 });
  }
}

/** A claim token is the ISO instant the claim was made (`claimWindow`), and nothing else. */
function claimToken(body: unknown): string | null {
  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || token.length === 0 || token.length > 40) return null;
  return Number.isNaN(Date.parse(token)) ? null : token;
}

export async function DELETE(req: NextRequest) {
  const keys = configuredBookingApiKeys(CANARY_CALLERS);
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return refuseBearerAuth(req.headers, auth);
  }
  const token = claimToken(await req.json().catch(() => null));
  if (token === null) {
    return NextResponse.json({ error: "A release needs the token the lease was taken with." }, { status: 400 });
  }
  const outcome = await releaseTestAdvisorLease(token);
  return NextResponse.json({ outcome }, { status: outcome === "refused" ? 500 : 200 });
}

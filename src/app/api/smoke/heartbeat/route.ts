import { NextResponse, type NextRequest } from "next/server";
import { authenticateBearer, CANARY_CALLERS } from "@/lib/booking/api-auth";
import { configuredBookingApiKeys } from "@/lib/booking/api-keys";
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
 * configured; 401 for a wrong or missing key.
 *
 * The optional `?lane=` selects which canary heartbeat to stamp, restricted to an
 * allowlist (#982): the 30-min dry tick stamps `smoke-canary`, the 6h full pass
 * additionally stamps `smoke-canary-full`, so a silently-dropped full run no
 * longer hides behind the dry tick's fresh stamp. The allowlist is a security
 * scope, not just validation: without it a booking-key holder could stamp a real
 * cron lane (e.g. `sync`) and keep the dead-man's switch looking alive while that
 * lane is actually dead. An unknown lane is rejected (400) and stamps nothing; the
 * default (no param) stays `smoke-canary` for the existing caller.
 */
const CANARY_HEARTBEAT_LANES = new Set([
  "smoke-canary",
  "smoke-canary-full",
  // The daily Slate against cal.com comparison (#2031). Stamped only after that
  // sweep reached a verdict, never merely because the workflow ran, so a sweep
  // that cannot read cal.com goes stale rather than reporting itself alive.
  "schedule-parity",
  // The weekly replay of routed cal.com leads through the Slate tier ladder
  // (#2263). Stamped only on a run that reached a USABLE verdict: a run cal.com
  // refused, or one whose sample was too thin to judge, leaves it unstamped,
  // because a blind detector keeping its heartbeat fresh is the state #1394
  // exists to find.
  "router-replay",
  // The daily proof that the burst counter answers (#2392). A detector verdict
  // lane rather than a plain one, and the only member of that family stamped from
  // outside the Worker: it records that the check CONCLUDED, never that the
  // workflow ran, so a run that could not reach the deployment leaves it
  // unstamped and it goes stale against VERDICT_STALE_BOUNDS_MS.
  "verdict:burst-counter",
  // The nightly proof that public booking can still be stopped (#2493). Same family
  // and same rule as the line above: it records that the check CONCLUDED, never that
  // the workflow ran, so a run the deployment never answered, or one that stood down
  // because somebody had already stopped bookings, leaves it unstamped.
  "verdict:kill-switch",
  // The availability latency reading the smoke canary takes (#1700). Same family
  // and same rule: it records that the check read a real median, never that the
  // step ran, so a run whose every request was refused leaves it unstamped.
  "verdict:availability-latency",
]);

export async function POST(req: NextRequest) {
  // #2645: the canary's own key (and the legacy shared pair) only, never a partner's.
  const keys = configuredBookingApiKeys(CANARY_CALLERS);
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const lane = new URL(req.url).searchParams.get("lane") ?? "smoke-canary";
  if (!CANARY_HEARTBEAT_LANES.has(lane)) {
    return NextResponse.json({ error: "unknown lane" }, { status: 400 });
  }
  await recordHeartbeat(lane);
  return NextResponse.json({ ok: true });
}

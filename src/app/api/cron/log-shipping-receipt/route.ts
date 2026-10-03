import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { LOG_SHIPPING_LANE } from "@/lib/monitor/health";

export const dynamic = "force-dynamic";

/**
 * Where the log shipping receipt is stamped (#3182). Not a lane and never
 * scheduled: Slate's `LogShippingReceipt` entrypoint (`worker/index.ts`) calls it in
 * process, with the cron bearer, each time the tail worker reports that Better Stack
 * accepted a cron tick's records. The lane watchdog pages when the stamp goes stale
 * (`LOG_SHIPPING_STALE_BOUNDS_MS`), which is how a revoked token or a stopped tail
 * worker stops looking like a quiet day.
 *
 * The bearer is the whole security scope: anybody able to stamp this could keep a
 * broken pipe looking alive, so it takes no lane from the request either.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  await recordHeartbeat(LOG_SHIPPING_LANE);
  return NextResponse.json({ stamped: LOG_SHIPPING_LANE });
}

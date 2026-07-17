import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { completePastBookings } from "@/lib/booking/service";
import { retryFailedDeliveries } from "@/lib/webhooks/emit";
import { acquireLock, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { reportCompletionSaturation } from "@/lib/monitor/sweep-saturation";

export const dynamic = "force-dynamic";

// #883 saturation streak key (rate_limits + alert_state rows): a sustained run
// of over-budget completion sweeps pages, so a growing backlog stops being a
// log-only signal that pages nobody and expires in 7 days.
const COMPLETION_SATURATED_KEY = "completion_sweep_saturated";

/** Marks finished bookings complete and retries failed webhook deliveries. */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // Two overlapping */5 ticks would both read the same finished booking and
  // race to flip it; the conditional transition in completePastBookings stops
  // the duplicate webhook, but the lock also keeps them from doing the work
  // twice (#163). Mirrors the cron_sync lock.
  const lock = await acquireLock("cron_complete", CRON_LOCK_TTL_MS);
  if (!lock) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    const { completed, backlogRemains } = await completePastBookings();
    const retried = await retryFailedDeliveries();
    // Dead-man's switch (#420/#685): prove this lane ran this tick. Best-effort.
    await recordHeartbeat("complete").catch(() => {});
    // #883: page when the sweep can't drain its backlog for several runs running.
    // After the heartbeat and guarded, so a monitoring hiccup can neither skip the
    // health stamp nor fail the lane it watches.
    await reportCompletionSaturation(COMPLETION_SATURATED_KEY, backlogRemains).catch(
      () => {},
    );
    return NextResponse.json({ completed, retried });
  } finally {
    await releaseLock("cron_complete", lock);
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { completePastBookings } from "@/lib/booking/service";
import { retryFailedDeliveries } from "@/lib/webhooks/emit";
import { acquireLock, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";

export const dynamic = "force-dynamic";

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
    const completed = await completePastBookings();
    const retried = await retryFailedDeliveries();
    return NextResponse.json({ completed, retried });
  } finally {
    await releaseLock("cron_complete", lock);
  }
}

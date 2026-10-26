import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { cancelDueDemoBookingsNow, completePastBookings } from "@/lib/booking/service";
import { retryFailedDeliveries } from "@/lib/webhooks/emit";
import { acquireLock, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { reportCompletionSaturation } from "@/lib/monitor/sweep-saturation";
import {
  reportSweepFailures,
  COMPLETION_SWEEP_FAILING_KEY,
  WEBHOOK_RETRY_SWEEP_FAILING_KEY,
  DEMO_AUTO_CANCEL_FAILING_KEY,
} from "@/lib/monitor/sweep-failure";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

// #883 saturation streak key (rate_limits + alert_state rows): a sustained run
// of over-budget completion sweeps pages, so a growing backlog stops being a
// log-only signal that pages nobody and expires in 7 days.
const COMPLETION_SATURATED_KEY = "completion_sweep_saturated";

/** Marks finished bookings complete, retries failed webhook deliveries, and
 *  cancels demo bookings past their 30 minutes (#3424). */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/complete");
  if (claimed) return claimed;

  // Two overlapping */5 ticks would both read the same finished booking and
  // race to flip it; the conditional transition in completePastBookings stops
  // the duplicate webhook, but the lock also keeps them from doing the work
  // twice (#163). Mirrors the cron_sync lock.
  // lock-overlap: completion flips a booking only from confirmed or rescheduled (a
  // status compare and swap), and webhook retries compare and swap on attempts, so an
  // overlapping run cannot complete or send twice.
  const lock = await acquireLock("cron_complete", CRON_LOCK_TTL_MS);
  if (!lock) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    // #887: the two jobs are independent and best-effort, mirroring the self-heal
    // lane. One throwing must not stop the other, skip the heartbeat, or 500 the
    // lane (which would fire the dead-man's switch for an unrelated failure).
    const completion = await completePastBookings().catch((err) => {
      log.error("complete", { msg: "completion sweep failed" }, err);
      return null;
    });
    const retried = await retryFailedDeliveries().catch((err) => {
      log.error("complete", { msg: "delivery retry failed" }, err);
      return null;
    });
    // #3424: demo bookings cancel themselves 30 minutes after they are made. Its
    // own boundary like the two above, so a failing cancel neither stops them nor
    // is stopped by them, and it reports through the same failing streak.
    const demo = await cancelDueDemoBookingsNow().catch((err) => {
      log.error("complete", { msg: "demo auto cancel failed" }, err);
      return null;
    });
    // Dead-man's switch (#420/#685): prove this lane ran this tick. Best-effort.
    // Stamped even when a job failed above (those log/alert on their own path);
    // the heartbeat only proves the lane executed.
    await recordHeartbeat("complete").catch(() => {});
    // #883: page when the sweep can't drain its backlog for several runs running.
    // After the heartbeat and guarded, so a monitoring hiccup can neither skip the
    // health stamp nor fail the lane it watches. A failed sweep (null) tells the
    // streak nothing; it must not fabricate a `false` that would clear a real backlog.
    await reportCompletionSaturation(
      COMPLETION_SATURATED_KEY,
      completion?.backlogRemains ?? null,
    ).catch(() => {});
    // #2544: and page when a sweep is not running AT ALL. The saturation streak
    // above is deliberately told nothing by a failed run (a sweep that threw knows
    // nothing about the backlog), and until now nothing else spoke for that
    // outcome either: the catch above it logged, this handler answered
    // `completed: "error"` on a 200, and the heartbeat was stamped either way, so
    // a sweep failing every five minutes paged nobody. A lane that is running and
    // achieving nothing now reads differently from a healthy one.
    const sweepOutcomes = [
      { key: COMPLETION_SWEEP_FAILING_KEY, ok: completion !== null },
      { key: WEBHOOK_RETRY_SWEEP_FAILING_KEY, ok: retried !== null },
      { key: DEMO_AUTO_CANCEL_FAILING_KEY, ok: demo !== null },
    ];
    await reportSweepFailures(sweepOutcomes).catch(() => {});
    return NextResponse.json({
      completed: completion?.completed ?? "error",
      retried: retried ?? "error",
      demoCancelled: demo?.cancelled ?? "error",
    });
  } finally {
    await releaseLock("cron_complete", lock);
  }
}

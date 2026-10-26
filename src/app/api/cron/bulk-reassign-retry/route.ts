import { NextResponse, type NextRequest } from "next/server";
import { retryUnplaceableCoverageJobs } from "@/lib/booking/service";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { CRON_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { acquireLease, releaseLock } from "@/lib/locks";
import { log } from "@/lib/log";
import { reportSweepFailures, COVERAGE_RETRY_SWEEP_FAILING_KEY } from "@/lib/monitor/sweep-failure";

export const dynamic = "force-dynamic";

/**
 * Hourly coverage-reassign RETRY lane (#3485 part C). A call a sweep settled
 * `unplaceable` is terminal: nothing re-attempts it, so it sits on an agent who will
 * not be there until a person moves it. "Nobody was free" is almost always transient at
 * the scale of hours (the eligible advisors were busy for that slot and its gaps right
 * then), so this re-arms every still-upcoming unplaceable call back to `pending` and lets
 * the every-five-minute drain do the live verify and the move. It does only the cheap
 * database re-arm itself (no Google calls), so it is safe to co-schedule on the hourly
 * trigger beside the roster reconcile.
 *
 * Its OWN lock so two retry ticks never overlap. It does not share the drain's lock: the
 * two touch disjoint statuses (this reads `unplaceable`, the drain works `pending`), and
 * the re-arm is conditional on the row still being unplaceable, so a raced move is never
 * undone.
 *
 * It carries no STALENESS watchdog: `LANE_STALE_BOUNDS_MS` omits hourly lanes because a
 * 60-minute bound is noisy (see `health.ts`). But a tick that THROWS is reported to the
 * `coverage_retry_sweep_failing` streak, which pages after two consecutive hourly failures
 * and clears on a real result, so a persistently broken lane is not invisible (its only
 * other symptom would be more `coverage_needs_human` pages). A failed tick still returns 200
 * with `{error}` rather than throwing, so one bad run does not retry-storm; the streak
 * decides when it matters. Even a dead lane is not a silent customer loss: every stranded
 * call is still surfaced by the stranded page one hour before the call (#3485 part C).
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/bulk-reassign-retry");
  if (claimed) return claimed;

  // lock-overlap: a repeat is safe. The re-arm is a conditional UPDATE (unplaceable ->
  // pending only) that is idempotent, and it touches a different status than the drain, so a
  // lost lock cannot double-move or undo anything; the lock only stops two retry ticks doing
  // the same no-op work at once.
  const lease = await acquireLease("cron_bulk_reassign_retry", CRON_LOCK_TTL_MS);
  if (!lease) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    const summary = await retryUnplaceableCoverageJobs().catch((err) => {
      log.error("bulk-reassign-retry", { msg: "retry failed" }, err);
      return null;
    });
    // A sweep that THROWS every run is a fault the stranded page would only surface as more
    // pages, so report the outcome to its streak: a sustained failure pages, a real result
    // clears it (#3485). Best-effort, so monitoring never takes down the lane it watches (L71).
    await reportSweepFailures([{ key: COVERAGE_RETRY_SWEEP_FAILING_KEY, ok: summary !== null }]).catch(
      (err) => log.error("bulk-reassign-retry", { msg: "sweep failure report failed" }, err),
    );
    if (summary) {
      log.info("bulk-reassign-retry", {
        msg: "retry tick",
        considered: summary.considered,
        reArmed: summary.reArmed,
      });
    }
    return NextResponse.json(summary ?? { error: "retry-failed" });
  } finally {
    await releaseLock("cron_bulk_reassign_retry", lease.token());
  }
}

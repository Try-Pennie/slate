import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import {
  drainBookingOutbox,
  drainBookingReservations,
  sweepAbandonedReschedulePins,
  sweepAbandonedReassignIntents,
} from "@/lib/booking/service";
import { acquireLock, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import {
  reportSweepFailures,
  OUTBOX_DRAIN_FAILING_KEY,
  RESERVATION_DRAIN_FAILING_KEY,
  RESCHEDULE_PIN_SWEEP_FAILING_KEY,
  REASSIGN_INTENT_SWEEP_FAILING_KEY,
} from "@/lib/monitor/sweep-failure";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Booking-outbox drain (#429 P2). Resumes any durable mutation-intent row whose
 * side effects aren't fully delivered, re-running only the not-done steps
 * idempotently. Its OWN lane + lock (cron_outbox), NOT the 25s sync tail, so a
 * busy sync tick can't starve it. A no-op until producers (P3/P4) write rows.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/outbox");
  if (claimed) return claimed;

  // One drain at a time: the per-row lease already prevents double-running a
  // single row, but the lock keeps two ticks from scanning the batch in
  // parallel for nothing. Mirrors cron_sync / cron_complete.
  // lock-overlap: every outbox row is leased by a token and each write compares and
  // swaps on it (src/lib/booking/outbox-lease.ts), so an overrunning drain cannot
  // complete a step another drain owns.
  const lock = await acquireLock("cron_outbox", CRON_LOCK_TTL_MS);
  if (!lock) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    // #3846: caught like the jobs below it. Its read throws on a failure now rather
    // than reading as an empty outbox, and an uncaught throw here would end the
    // tick before the reservation drain, both sweeps and the heartbeat. null, never
    // a zero count, because a drain that threw measured nothing; the failing streak
    // below is what speaks for it.
    const outbox = await drainBookingOutbox().catch((err) => {
      log.error("outbox", { msg: "outbox drain failed" }, err);
      return null;
    });
    // Same lane resumes crashed create reservations (#429 P4) + sweeps abandoned
    // ones. Best-effort: a failure here must not break the outbox drain. Logged and
    // fed to the failing streak below (#3077), because a bare catch here was the
    // only place a drain throwing on every tick was recorded, and it kept nothing.
    const reservations = await drainBookingReservations().catch((err) => {
      log.error("outbox", { msg: "reservation drain failed" }, err);
      return null;
    });
    // GC abandoned reschedule lease-pins (#439): cleanup only, best-effort.
    const reschedulePins = await sweepAbandonedReschedulePins().catch((err) => {
      log.error("outbox", { msg: "reschedule pin sweep failed" }, err);
      return null;
    });
    // GC abandoned standalone-reassign create intents (#518): cleanup + fail-loud
    // alert on a genuinely-lost reassign, best-effort.
    const reassignIntents = await sweepAbandonedReassignIntents().catch((err) => {
      log.error("outbox", { msg: "reassign intent sweep failed" }, err);
      return null;
    });
    // Dead-man's switch (#420/#685): prove this lane ran this tick. Best-effort.
    // Stamped even when a sweep failed: it proves the LANE executed, and the
    // streak below is what speaks for a sweep that did not.
    await recordHeartbeat("outbox").catch(() => {});
    // #3077: page when a sweep has thrown on several consecutive ticks, mirroring
    // the complete lane (#2544). After the heartbeat and guarded, so a monitoring
    // hiccup can neither skip the health stamp nor fail the lane it watches.
    const sweepOutcomes = [
      { key: OUTBOX_DRAIN_FAILING_KEY, ok: outbox !== null },
      { key: RESERVATION_DRAIN_FAILING_KEY, ok: reservations !== null },
      { key: RESCHEDULE_PIN_SWEEP_FAILING_KEY, ok: reschedulePins !== null },
      { key: REASSIGN_INTENT_SWEEP_FAILING_KEY, ok: reassignIntents !== null },
    ];
    await reportSweepFailures(sweepOutcomes).catch(() => {});
    return NextResponse.json({ outbox, reservations, reschedulePins, reassignIntents });
  } finally {
    await releaseLock("cron_outbox", lock);
  }
}

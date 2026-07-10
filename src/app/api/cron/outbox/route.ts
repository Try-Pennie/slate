import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import {
  drainBookingOutbox,
  drainBookingReservations,
  sweepAbandonedReschedulePins,
  sweepAbandonedReassignIntents,
} from "@/lib/booking/service";
import { acquireLock, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";

export const dynamic = "force-dynamic";

/**
 * Booking-outbox drain (#429 P2). Resumes any durable mutation-intent row whose
 * side effects aren't fully delivered, re-running only the not-done steps
 * idempotently. Its OWN lane + lock (cron_outbox), NOT the 25s sync tail, so a
 * busy sync tick can't starve it. A no-op until producers (P3/P4) write rows.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // One drain at a time: the per-row lease already prevents double-running a
  // single row, but the lock keeps two ticks from scanning the batch in
  // parallel for nothing. Mirrors cron_sync / cron_complete.
  const lock = await acquireLock("cron_outbox", CRON_LOCK_TTL_MS);
  if (!lock) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    const outbox = await drainBookingOutbox();
    // Same lane resumes crashed create reservations (#429 P4) + sweeps abandoned
    // ones. Best-effort: a failure here must not break the outbox drain.
    const reservations = await drainBookingReservations().catch(() => null);
    // GC abandoned reschedule lease-pins (#439): cleanup only, best-effort.
    const reschedulePins = await sweepAbandonedReschedulePins().catch(() => null);
    // GC abandoned standalone-reassign create intents (#518): cleanup + fail-loud
    // alert on a genuinely-lost reassign, best-effort.
    const reassignIntents = await sweepAbandonedReassignIntents().catch(() => null);
    // Dead-man's switch (#420/#685): prove this lane ran this tick. Best-effort.
    await recordHeartbeat("outbox").catch(() => {});
    return NextResponse.json({ outbox, reservations, reschedulePins, reassignIntents });
  } finally {
    await releaseLock("cron_outbox", lock);
  }
}

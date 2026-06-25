import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { drainBookingOutbox, drainBookingReservations } from "@/lib/booking/service";
import { acquireLock, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";

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
    return NextResponse.json({ outbox, reservations });
  } finally {
    await releaseLock("cron_outbox", lock);
  }
}

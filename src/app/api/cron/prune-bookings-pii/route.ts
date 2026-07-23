import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { bookingPiiCutoffIso, REDACTED_BOOKING_UPDATE } from "@/lib/booking/pii-retention";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 120_000;
// Bounded batch per run = cap-safe on the growth `bookings` table. There is no
// backlog today (nothing is 24 months old yet), and at PoC scale a daily batch of
// this size clears any future aging comfortably.
const BATCH = 500;
// Delivered outbox rows are operational cruft (their steps jsonb can also carry
// PII); prune them well after the drain is done with them.
const OUTBOX_DELIVERED_RETENTION_DAYS = 30;

/**
 * #1071 (part of the #1029 milestone): redact consumer PII on bookings whose
 * appointment is past the retention window, enqueue deletion of the external
 * Google Calendar event, and prune delivered outbox rows. Mirrors prune-routing
 * (own lock, fail-loud). Keyed on the appointment time, not a completion status a
 * sweep might miss (#883). The reschedule/cancel reason text (append-only
 * booking_events) is redacted separately once the #1040 lock + erasure escape
 * hatch land (#1070).
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });
  const lock = await acquireLock("cron_prune_bookings_pii", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const db = supabaseAdmin();
    const nowMs = Date.now();
    const cutoff = bookingPiiCutoffIso(new Date(nowMs).toISOString());

    // Aged, not-yet-redacted bookings (attendee_email still present). The batch
    // limit keeps this cap-safe on a growth table, and the not-null filter makes
    // it idempotent: a redacted row drops out, so re-runs and the batch shrink.
    const { data: aged, error: readErr } = await db
      .from("bookings")
      .select("id, assigned_user_id, gcal_event_id")
      .lt("starts_at", cutoff)
      .not("attendee_email", "is", null)
      .limit(BATCH);
    if (readErr) throw new Error(readErr.message);
    const rows = (aged ?? []) as {
      id: string;
      assigned_user_id: string;
      gcal_event_id: string | null;
    }[];

    let enqueued = 0;
    if (rows.length > 0) {
      // Enqueue external calendar-event deletions through the crash-safe #401
      // queue (a cheap idempotent upsert) rather than calling Google inline; its
      // drain does the retried delete. The event lives on the assigned agent's
      // calendar, keyed by their email.
      const withGcal = rows.filter((r) => r.gcal_event_id);
      if (withGcal.length > 0) {
        const userIds = [...new Set(withGcal.map((r) => r.assigned_user_id))];
        // cap-safe: primary-key lookup bounded by the batch's distinct agents.
        const { data: users, error: uErr } = await db
          .from("users")
          .select("id, email")
          .in("id", userIds);
        if (uErr) throw new Error(uErr.message);
        const emailById = new Map(
          ((users ?? []) as { id: string; email: string }[]).map((u) => [u.id, u.email]),
        );
        for (const r of withGcal) {
          const email = emailById.get(r.assigned_user_id);
          if (!email || !r.gcal_event_id) continue;
          const { error } = await db.from("pending_event_deletions").upsert(
            { calendar_email: email, gcal_event_id: r.gcal_event_id, booking_id: r.id },
            { onConflict: "calendar_email,gcal_event_id", ignoreDuplicates: true },
          );
          if (error) throw new Error(error.message);
          enqueued++;
        }
      }

      // Redact the batch in place (keeps aggregate rows + FK integrity).
      const { error: updErr } = await db
        .from("bookings")
        .update(REDACTED_BOOKING_UPDATE)
        .in(
          "id",
          rows.map((r) => r.id),
        );
      if (updErr) throw new Error(updErr.message);
    }

    // Prune delivered outbox rows (a slow storage leak).
    const outboxCutoff = new Date(
      nowMs - OUTBOX_DELIVERED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { error: obErr, count: outboxPruned } = await db
      .from("booking_outbox")
      .delete({ count: "exact" })
      .eq("status", "delivered")
      .lt("created_at", outboxCutoff);
    if (obErr) throw new Error(obErr.message);

    return NextResponse.json({
      redacted: rows.length,
      enqueued,
      outboxPruned: outboxPruned ?? 0,
      cutoff,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("prune-bookings-pii", { msg: "cron failed", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseLock("cron_prune_bookings_pii", lock);
  }
}

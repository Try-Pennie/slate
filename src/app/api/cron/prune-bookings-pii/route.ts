import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { bookingPiiCutoffIso, REDACTED_BOOKING_UPDATE } from "@/lib/booking/pii-retention";
import { exportedThrough, mirrorReadyForDeletion } from "@/lib/snowflake/retention-gate";
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
 * #1071 (part of the #1029 milestone): redact the direct consumer contact data on
 * bookings whose appointment is past the retention window, and prune delivered
 * outbox rows. Mirrors prune-routing (own lock, fail-loud). Keyed on the
 * appointment time, not a completion status a sweep might miss (#883).
 *
 * Deliberately narrow: it clears only the contact fields Slate collected (name/
 * email/phone/prefill), NOT salesforce_id/external_id (the external Salesforce
 * reference), and it does NOT touch the agent's Google Calendar (a completed
 * meeting's event stays; only a real cancellation deletes it). The reschedule/
 * cancel reason text (append-only booking_events) is redacted separately once the
 * #1040 lock + erasure escape hatch land (#1070).
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });
  const lock = await acquireLock("cron_prune_bookings_pii", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const db = supabaseAdmin();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const cutoff = bookingPiiCutoffIso(nowIso);

    // Export-gated (#1118): redacting a booking bumps its updated_at, and the
    // export lane freezes it out afterward, so we must be sure Snowflake already
    // holds the full-fidelity version FIRST. Gate the whole run on a passing
    // reconciliation, and only redact rows STRICTLY before the confirmed-export
    // watermark. Strict `<` (not `<=`): the export cursor is a composite
    // (updated_at, id) keyset, so a row whose updated_at equals the watermark but
    // whose id sorts after the last exported id was NOT yet exported.
    const gate = await mirrorReadyForDeletion();
    if (!gate.ready) {
      log.info("prune-bookings-pii", { msg: "skipped: mirror not ready", reason: gate.reason });
      return NextResponse.json({ skipped: "mirror-not-ready", reason: gate.reason });
    }
    const bookingsExportedTo = await exportedThrough("bookings");
    if (!bookingsExportedTo) return NextResponse.json({ skipped: "nothing-exported-yet" });

    // Aged, not-yet-redacted bookings (attendee_email still present) whose latest
    // version is already in Snowflake. The batch limit keeps this cap-safe on a
    // growth table, and the not-null filter makes it idempotent: a redacted row
    // drops out, so re-runs and the batch shrink.
    const { data: aged, error: readErr } = await db
      .from("bookings")
      .select("id")
      .lt("starts_at", cutoff)
      .not("attendee_email", "is", null)
      .lt("updated_at", bookingsExportedTo)
      .limit(BATCH);
    if (readErr) throw new Error(readErr.message);
    const rows = (aged ?? []) as { id: string }[];

    if (rows.length > 0) {
      // Redact the contact fields in place (keeps aggregate rows + FK integrity),
      // and stamp pii_redacted_at so the export freezes the row at its last
      // full-fidelity version instead of re-MERGEing the blanked one (#1118).
      const { error: updErr } = await db
        .from("bookings")
        .update({ ...REDACTED_BOOKING_UPDATE, pii_redacted_at: nowIso })
        .in(
          "id",
          rows.map((r) => r.id),
        );
      if (updErr) throw new Error(updErr.message);
    }

    // Prune delivered outbox rows (a slow storage leak), also export-gated: only
    // hard-delete a delivered row Snowflake already holds. booking_outbox is
    // mirrored on updated_at, so gate on that watermark (strict `<`, same reason).
    const outboxCutoff = new Date(
      nowMs - OUTBOX_DELIVERED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const outboxExportedTo = await exportedThrough("booking_outbox");
    let outboxPruned = 0;
    if (outboxExportedTo) {
      const { error: obErr, count } = await db
        .from("booking_outbox")
        .delete({ count: "exact" })
        .eq("status", "delivered")
        .lt("created_at", outboxCutoff)
        .lt("updated_at", outboxExportedTo);
      if (obErr) throw new Error(obErr.message);
      outboxPruned = count ?? 0;
    }

    return NextResponse.json({
      redacted: rows.length,
      outboxPruned,
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

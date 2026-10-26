import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { bookingPiiCutoffIso, REDACTED_BOOKING_UPDATE } from "@/lib/booking/pii-retention";
import { exportedThrough, mirrorReadyForDeletion } from "@/lib/snowflake/retention-gate";
import { MAX_VERIFY_BATCH, destroyVerified, type VerifyVerdict } from "@/lib/snowflake/verify-archived";
import { repairUnverified } from "@/lib/snowflake/reexport";
import { alertRetentionResumed, alertRetentionSkipped, laneCompleted } from "@/lib/snowflake/retention-lane";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 120_000;
// Bounded batch per run = cap-safe on the growth `bookings` table. There is no
// backlog today (nothing is 24 months old yet), and at PoC scale a daily batch of
// this size clears any future aging comfortably.
const BATCH = 500;
// Delivered outbox rows are operational cruft; prune them well after the drain is
// done with them. Their PII exposure is narrower than this comment used to claim
// (it said "steps jsonb can also carry PII", which #1140 measured against prod and
// found to mean the payload's free-text `reasonDetail`, plus an error string that
// could embed an external response body, NOT attendee name/email/phone/prefill).
// A DELETION REQUEST no longer waits on this window: erase_booking_pii clears
// those fields immediately (migration 0093), which matters because this prune is
// pausable and so cannot be relied on as the erasure path.
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
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/prune-bookings-pii");
  if (claimed) return claimed;
  // lock-overlap: the redaction and the outbox delete are idempotent by id, so a second
  // run only re-stamps pii_redacted_at.
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
      await alertRetentionSkipped("prune-bookings-pii", gate.reason ?? "unknown");
      return laneCompleted("prune-bookings-pii", { skipped: "mirror-not-ready", reason: gate.reason });
    }
    const bookingsExportedTo = await exportedThrough("bookings");
    if (!bookingsExportedTo) {
      await alertRetentionSkipped("prune-bookings-pii", "nothing exported yet");
      return laneCompleted("prune-bookings-pii", { skipped: "nothing-exported-yet" });
    }
    // #1151: past both gates, so this lane really is deleting again.
    await alertRetentionResumed("prune-bookings-pii");

    // Aged, not-yet-redacted bookings (attendee_email still present) whose latest
    // version is already in Snowflake. The batch limit keeps this cap-safe on a
    // growth table, and the not-null filter makes it idempotent: a redacted row
    // drops out, so re-runs and the batch shrink.
    const { data: aged, error: readErr } = await db
      .from("bookings")
      .select("id,updated_at")
      .lt("starts_at", cutoff)
      .not("attendee_email", "is", null)
      .lt("updated_at", bookingsExportedTo)
      .order("starts_at", { ascending: true })
      .limit(BATCH);
    if (readErr) throw new Error(readErr.message);
    const rows = (aged ?? []) as { id: string; updated_at: string }[];

    // Prove the warehouse holds each row's full-fidelity version before blanking
    // it (#1102). Redaction is irreversible, so it needs the same proof a delete
    // does: this is the ONLY copy of that contact data once the row is blanked.
    const bookingsReport = await destroyVerified({
      table: "bookings",
      watermarkCol: "updated_at",
      candidates: rows.map((r) => ({ id: r.id, watermark: r.updated_at })),
      repair: repairUnverified,
      destroy: async (ids) => {
        // Redact the contact fields in place (keeps aggregate rows + FK integrity),
        // and stamp pii_redacted_at so the export freezes the row at its last
        // full-fidelity version instead of re-MERGEing the blanked one (#1118).
        const { error: updErr, count } = await db
          .from("bookings")
          .update({ ...REDACTED_BOOKING_UPDATE, pii_redacted_at: nowIso }, { count: "exact" })
          .in("id", ids);
        if (updErr) throw new Error(updErr.message);
        return count ?? 0;
      },
    });

    // Prune delivered outbox rows (a slow storage leak), also export-gated: only
    // hard-delete a delivered row Snowflake already holds. booking_outbox is
    // mirrored on updated_at, so gate on that watermark (strict `<`, same reason).
    const outboxCutoff = new Date(
      nowMs - OUTBOX_DELIVERED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const outboxExportedTo = await exportedThrough("booking_outbox");
    let outboxReport = { candidates: 0, destroyed: 0, problems: [] as VerifyVerdict[] };
    if (outboxExportedTo) {
      // booking_outbox needs the read-back MORE than the other tables, not less:
      // it has no set_updated_at trigger, so every writer stamps updated_at from
      // the Worker's own clock. A row committed with an earlier stamp after the
      // export cursor moved past it is skipped by the strictly-forward keyset
      // fetch and never reaches the warehouse, while still passing the watermark
      // predicate. Only asking the warehouse catches that.
      const { data: agedOutbox, error: obReadErr } = await db
        .from("booking_outbox")
        .select("id,updated_at")
        .eq("status", "delivered")
        .lt("created_at", outboxCutoff)
        .lt("updated_at", outboxExportedTo)
        .order("created_at", { ascending: true })
        .limit(MAX_VERIFY_BATCH);
      if (obReadErr) throw new Error(obReadErr.message);
      const obCandidates = ((agedOutbox ?? []) as { id: string; updated_at: string }[]).map((r) => ({
        id: r.id,
        watermark: r.updated_at,
      }));
      outboxReport = await destroyVerified({
        table: "booking_outbox",
        watermarkCol: "updated_at",
        candidates: obCandidates,
        repair: repairUnverified,
      destroy: async (ids) => {
          const { error: obErr, count } = await db
            .from("booking_outbox")
            .delete({ count: "exact" })
            .in("id", ids);
          if (obErr) throw new Error(obErr.message);
          return count ?? 0;
        },
      });
    }

    const unverified = [...bookingsReport.problems, ...outboxReport.problems];
    if (unverified.length > 0) {
      log.warn("prune-bookings-pii", {
        msg: "left unverified rows in place",
        unverified: unverified.length,
        first: unverified[0].id,
        state: unverified[0].state,
      });
    }

    return laneCompleted("prune-bookings-pii", {
      redacted: bookingsReport.destroyed,
      outboxPruned: outboxReport.destroyed,
      cutoff,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("prune-bookings-pii", { msg: "cron failed", error: message });
    return laneFailure("prune-bookings-pii", message);
  } finally {
    await releaseLock("cron_prune_bookings_pii", lock);
  }
}

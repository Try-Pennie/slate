import type { WebhookEvent } from "@/lib/db/types";

/**
 * Deterministic dedupe key for a booking webhook (#436 / #429 P1). Stored on the
 * `webhook_deliveries` row under a partial UNIQUE (endpoint_id, event, dedupe_key)
 * so a re-enqueue of the SAME logical event inserts nothing and re-sends nothing
 * — exactly-once to Regal/Cadence — while a genuinely new action still fires.
 *
 * - `booking.created`: no `booking_events` row exists, and there is exactly
 *   one per booking, ever → key on the booking id.
 * - `booking.rescheduled` / `booking.cancelled`: key on the
 *   `booking_events` row id, which is fresh per action — so a legitimate SECOND
 *   reschedule is NOT deduped away.
 * - `booking.reassigned` (#2368): the same branch, but the caller passes the
 *   reassign's OUTBOX ROW id rather than a history row id. A reassign has no
 *   natural per-operation key in `booking_events` (the time does not move, so
 *   there is nothing to version by), and the outbox row id is stable across the
 *   inline run and a drain resume of the same reassign, which is exactly the
 *   exactly-once property this key exists for.
 * - `booking.contact_updated` (#1512): the caller passes no id, so the key is
 *   null and every correction fires. A correction has no history row, and a key
 *   built from the booking would drop a lead's second correction.
 * - A mutation whose history insert failed (no id available, a best-effort path
 *   that already logs + alerts) returns `null`: with a null key the partial
 *   unique index does not apply, so the webhook still fires (at-least-once). We
 *   never drop a webhook to chase exactly-once.
 */
export function webhookDedupeKey(
  event: WebhookEvent,
  ctx: { bookingId: string; bookingEventId: string | null },
): string | null {
  if (event === "booking.created") {
    return ctx.bookingId;
  }
  return ctx.bookingEventId;
}

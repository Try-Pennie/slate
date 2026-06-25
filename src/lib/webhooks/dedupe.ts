import type { WebhookEvent } from "@/lib/db/types";

/**
 * Deterministic dedupe key for a booking webhook (#436 / #429 P1). Stored on the
 * `webhook_deliveries` row under a partial UNIQUE (endpoint_id, event, dedupe_key)
 * so a re-enqueue of the SAME logical event inserts nothing and re-sends nothing
 * — exactly-once to Regal/Cadence — while a genuinely new action still fires.
 *
 * - `booking.created` / `booking.completed`: no `booking_events` row exists, and
 *   there is exactly one of each per booking, ever → key on the booking id.
 * - `booking.rescheduled` / `booking.cancelled` / `booking.reassigned`: key on the
 *   `booking_events` row id, which is fresh per action — so a legitimate SECOND
 *   reschedule is NOT deduped away.
 * - A mutation whose history insert failed (no id available, a best-effort path
 *   that already logs + alerts) returns `null`: with a null key the partial
 *   unique index does not apply, so the webhook still fires (at-least-once). We
 *   never drop a webhook to chase exactly-once.
 */
export function webhookDedupeKey(
  event: WebhookEvent,
  ctx: { bookingId: string; bookingEventId: string | null },
): string | null {
  if (event === "booking.created" || event === "booking.completed") {
    return ctx.bookingId;
  }
  return ctx.bookingEventId;
}

import { DateTime } from "luxon";

/**
 * Consumer booking PII retention (#1071, part of the #1029 milestone). Bookings
 * hold attendee name/email/phone, a prefill blob, and the strong identity keys
 * salesforce_id/external_id (person-dedupe.ts). The retention cron redacts these
 * on bookings whose appointment is past this window. Provisional 24 months,
 * pending Pennie legal per #1029.
 */
export const BOOKING_PII_RETENTION_MONTHS = 24;

/** ISO timestamp `months` before `nowIso`; bookings whose appointment (starts_at)
 * is older than this have their PII redacted. Keyed on the appointment time, not
 * a completion status a sweep might miss (#883). */
export function bookingPiiCutoffIso(
  nowIso: string,
  months = BOOKING_PII_RETENTION_MONTHS,
): string {
  return DateTime.fromISO(nowIso, { zone: "utc" })
    .minus({ months })
    .toUTC()
    .toISO({ suppressMilliseconds: false })!;
}

/**
 * The redaction applied to an aged booking. Clears ONLY the direct contact data
 * Slate collected on the public booker: name, email, phone, and the prefill blob
 * (which can carry PII). Redaction in place (not hard-delete) preserves aggregate
 * rows and foreign-key integrity.
 *
 * It deliberately does NOT clear salesforce_id/external_id: those are the same
 * external Salesforce reference, and Slate is not the system of record for that
 * identity, so retention there is Salesforce's job (Dan, 2026-07-23). Nor does
 * retention touch the agent's Google Calendar; a completed meeting's event stays,
 * and only a real cancellation deletes it. The reschedule/cancel reason text in
 * the append-only booking_events table is redacted separately once the #1040
 * tamper-evidence lock and its erasure escape hatch land (#1070).
 */
export const REDACTED_BOOKING_UPDATE: {
  attendee_name: null;
  attendee_email: null;
  attendee_phone: null;
  prefill: Record<string, never>;
} = {
  attendee_name: null,
  attendee_email: null,
  attendee_phone: null,
  prefill: {},
};

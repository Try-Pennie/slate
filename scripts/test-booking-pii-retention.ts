// #1071: retention for consumer booking PII. Bookings hold attendee name/email/
// phone (+ prefill) and the strong identity keys salesforce_id/external_id, kept
// forever. The retention cron redacts these on bookings whose appointment is past
// the window. This locks the pure pieces: the window default and the exact set of
// columns cleared (a missed column silently retains re-identifiable PII, which the
// #1029 red-team flagged for salesforce_id/external_id).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-pii-retention.ts
import {
  BOOKING_PII_RETENTION_MONTHS,
  bookingPiiCutoffIso,
  REDACTED_BOOKING_UPDATE,
} from "../src/lib/booking/pii-retention.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// Provisional window, pending Pennie legal (#1029).
eq(BOOKING_PII_RETENTION_MONTHS, 24, "retention window is 24 months");

// Keyed on the appointment time, not a status a sweep might miss (#883).
eq(
  bookingPiiCutoffIso("2026-07-23T12:00:00.000Z").slice(0, 7),
  "2024-07",
  "cutoff is 24 months before now",
);

// Clears ONLY the direct contact data Slate collected: name, email, phone, and
// the prefill blob (may carry PII). Redaction in place (not hard-delete) keeps
// aggregate rows + FK integrity.
eq(REDACTED_BOOKING_UPDATE.attendee_name, null, "clears attendee_name");
eq(REDACTED_BOOKING_UPDATE.attendee_email, null, "clears attendee_email");
eq(REDACTED_BOOKING_UPDATE.attendee_phone, null, "clears attendee_phone");
assert(
  JSON.stringify(REDACTED_BOOKING_UPDATE.prefill) === "{}",
  "blanks the prefill blob to an empty object",
);

// salesforce_id and external_id are the SAME external Salesforce reference, and
// Slate is not the system of record for that identity, so retention must NOT
// clear them (Dan, 2026-07-23). Only the contact copy Slate collected is scrubbed.
assert(
  !("salesforce_id" in REDACTED_BOOKING_UPDATE),
  "does NOT clear salesforce_id (external reference, kept)",
);
assert(
  !("external_id" in REDACTED_BOOKING_UPDATE),
  "does NOT clear external_id (same external reference, kept)",
);

finish();

// Pure builder for the #668 create-resume smoke: given a booking that was ALREADY
// persisted (via the direct API), produce the pending `booking_reservations` row
// that a crash-after-insert would have left behind. Driving the drain over this
// row makes `completeReservation` take its "already inserted" branch (found by
// idempotency_key), re-run the idempotent side effects, and re-fire
// booking.created, which the webhook_deliveries dedupe must collapse to nothing.
//
// Kept pure (no DB/network) so the row shape is unit-tested
// (scripts/test-create-resume-reservation.ts) before the live smoke touches a
// real project (same split as smoke-seed.ts / test-smoke-seed.ts).

import type {
  Booking,
  BookingInsert,
  BookingReservationInsert,
} from "../src/lib/db/types.ts";

/** The booking columns the builder reads back from PostgREST after the create. */
export type PersistedBookingRow = Pick<
  Booking,
  | "org_id"
  | "bucket_id"
  | "event_type_id"
  | "assigned_user_id"
  | "agent_name"
  | "agent_email"
  | "starts_at"
  | "ends_at"
  | "original_starts_at"
  | "original_ends_at"
  | "timezone"
  | "status"
  | "salesforce_id"
  | "attendee_name"
  | "attendee_email"
  | "attendee_phone"
  | "prefill"
  | "gcal_event_id"
  | "manage_token"
  | "idempotency_key"
  | "external_id"
  | "routing_trace"
>;

/**
 * Build the synthetic pending reservation for a persisted booking. Throws if the
 * booking has no idempotency_key or no assigned agent: the resume is keyed on the
 * idempotency_key, and the reservation's pinned columns are NOT NULL, so a row
 * missing either could never have been produced by a real keyed create and would
 * make the drain a no-op instead of exercising the resume.
 */
export function buildResumeReservation(
  b: PersistedBookingRow,
  bucketCode: string,
): BookingReservationInsert {
  if (!b.idempotency_key) {
    throw new Error("booking has no idempotency_key; cannot key a resume reservation");
  }
  if (!b.assigned_user_id || !b.agent_email) {
    throw new Error("booking has no assigned agent; reservation pinned columns are NOT NULL");
  }

  // The exact row the crashed create would have inserted. On the resume's
  // already-inserted branch only `idempotency_key` (the lookup key) and the
  // bucketCode are read from the payload; the rest is reconstructed faithfully so
  // the row is a valid ReservationPayload and would also complete a fresh create.
  const bookingInsert: BookingInsert = {
    org_id: b.org_id,
    bucket_id: b.bucket_id,
    event_type_id: b.event_type_id,
    assigned_user_id: b.assigned_user_id,
    agent_name: b.agent_name,
    agent_email: b.agent_email,
    starts_at: b.starts_at,
    ends_at: b.ends_at,
    original_starts_at: b.original_starts_at,
    original_ends_at: b.original_ends_at,
    timezone: b.timezone,
    status: "confirmed",
    salesforce_id: b.salesforce_id,
    attendee_name: b.attendee_name,
    attendee_email: b.attendee_email,
    attendee_phone: b.attendee_phone,
    prefill: b.prefill,
    // The pinned client id IS the stored event id: a re-create 409-reuses it.
    gcal_event_id: b.gcal_event_id,
    manage_token: b.manage_token,
    idempotency_key: b.idempotency_key,
    external_id: b.external_id,
    routing_trace: b.routing_trace,
  };

  return {
    idempotency_key: b.idempotency_key,
    pinned_user_id: b.assigned_user_id,
    pinned_agent_email: b.agent_email,
    gcal_client_id: b.gcal_event_id,
    payload: {
      booking: bookingInsert,
      event: {
        summary: b.attendee_name ? `Booking with ${b.attendee_name}` : "Booking",
        description: `manage:${b.manage_token}`,
        start: b.starts_at,
        end: b.ends_at,
        timezone: b.timezone,
        attendeeEmail: b.attendee_email,
        attendeeName: b.attendee_name,
      },
      // Used only as the fallback bucket code if the persisted booking's
      // routing_trace somehow lacks one; the resume prefers routing_trace.
      bucketCode,
    },
  };
}

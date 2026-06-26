import type {
  BookingStatus,
  BookingEventInitiator,
  RoutingTrace,
} from "@/lib/db/types";

/** Routing/fallback summary on the booking event, so Regal can suppress its
 *  "Non-Ultra High Team Booking Detected" alert on intentional tier-drops. */
export interface RoutingMeta {
  empty_pool_fallback: boolean;
  tier_fallback: boolean;
  requested_tier: string | null;
  booked_tier: string | null;
  rungs_dropped: number;
}

export function routingMetaFromTrace(trace: RoutingTrace | null): RoutingMeta {
  return {
    empty_pool_fallback: trace?.fallback_applied ?? false,
    tier_fallback: trace?.tier_fallback ?? false,
    requested_tier: trace?.requested_tier ?? null,
    booked_tier: trace?.booked_tier ?? null,
    rungs_dropped: trace?.rungs_dropped ?? 0,
  };
}

/** Why a booking was rescheduled/cancelled + who did it (#326). Null on create/complete. */
export interface BookingReasonMeta {
  /** Stable reason code (analytics dimension). */
  code: string;
  /** Free text for the "other" code; null otherwise. */
  detail: string | null;
  initiator: BookingEventInitiator;
}

/** Canonical payload Slate builds per booking event (stored on the delivery). */
export interface BookingEventPayload {
  booking_id: string;
  salesforce_id: string | null;
  bucket_code: string;
  event_type: string; // display title, e.g. "Senior Loan Advisor Call"
  event_type_slug: string; // Regal `type`, e.g. "call"
  event_description: string | null;
  status: BookingStatus;
  starts_at: string;
  ends_at: string;
  timezone: string;
  agent: { id: string; name: string | null; email: string };
  attendee: { name: string | null; email: string | null; phone: string | null };
  prefill: Record<string, string>;
  manage_url: string;
  /**
   * Reason + initiator for booking.rescheduled / booking.cancelled (#326).
   * Null on booking.created / booking.completed (no reason applies).
   */
  reason: BookingReasonMeta | null;
  routing: RoutingMeta;
}

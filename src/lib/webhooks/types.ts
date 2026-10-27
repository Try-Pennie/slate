import type {
  BookingKind,
  BookingStatus,
  BookingEventInitiator,
  RoutingTrace,
  WebhookEvent,
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

/** Why a booking was rescheduled/cancelled + who did it (#326). Null on create. */
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
  /**
   * `first_name` is the first name the lead answered (#2549), null when the
   * booking holds none. Optional because a stored payload written before it
   * existed carries no key, and a resend rebuilds from that payload.
   */
  attendee: { name: string | null; email: string | null; phone: string | null; first_name?: string | null };
  prefill: Record<string, string>;
  manage_url: string;
  /**
   * Reason + initiator for booking.rescheduled / booking.cancelled (#326).
   * Null on booking.created (no reason applies).
   */
  reason: BookingReasonMeta | null;
  /**
   * The advisor the booking was assigned to BEFORE the change (#2368). Set on
   * `booking.reassigned`, null on every other event.
   *
   * Null also means "we do not know", and that is deliberate: it is read from the
   * reassign's outbox row, so a row enqueued before the field existed carries
   * nothing, and the booking row itself holds the NEW advisor by the time the
   * payload is built. Naming the wrong person on a Regal timeline is worse than
   * naming nobody (L192).
   */
  previous_agent_email: string | null;
  /**
   * The number a phone correction replaced (#1512). Set on
   * `booking.contact_updated`, where `attendee.phone` already holds the new
   * one, so a CRM matching on phone can find the record it is updating. Also set on
   * a `booking.rescheduled` whose move corrected the number (#2164, #4031), and
   * ONLY then: its presence there is what says the number is a correction, which
   * Regal is told by naming it primary and subscribed. Optional because no other
   * event carries it and a stored payload written before it existed has no key; a
   * reader treats absent as "not known" (on a reschedule, "not corrected").
   */
  previous_attendee_phone?: string | null;
  /**
   * How the booking routed. NULL for an agent link booking (#2073): nothing was
   * routed, so there is no outcome to report, and a summary of all falses would
   * claim a routed booking that dropped no tier.
   */
  routing: RoutingMeta | null;
  /**
   * #2073: `agent_link` when the lead booked through their advisor's own named
   * link rather than being routed. Optional because a payload stored before the
   * field existed has none, and every such booking was routed.
   */
  booking_kind?: BookingKind;
  /**
   * #4204: true on the event of a move that took the call OFF the placeholder advisor
   * onto a real one, so Regal is told Marcia stops texting. Absent on every other
   * event, and on any payload stored before the field existed.
   */
  left_placeholder?: boolean;
  /**
   * #4273: set on a `booking.cancelled` whose contact flags must NOT reach Regal, and
   * why. Regal applies an event's traits to the contact, so a cancel of an older
   * booking would overwrite the flags the customer's newer, still live booking set
   * (`another-live-booking`); and when that could not be checked, the flags are left
   * out rather than risk it (`lookup-failed`). Decided when the payload is built and
   * stored with it, so a resend and the dead letter replay send the same. Absent on
   * every other event, on a cancel that left no live booking, and on any payload
   * stored before the field existed, all of which send the flags as before.
   */
  contact_properties_withheld?: ContactPropertiesWithheld;
}

/** #4273: why a cancel's contact flags are left out of its Regal event. */
export type ContactPropertiesWithheld = "another-live-booking" | "lookup-failed";

/** The booking events, the family `buildRegalEvent` describes. */
export type BookingWebhookEvent = Extract<WebhookEvent, `booking.${string}`>;

/** The agent events (#2085), whose Regal body is a traits only update. */
export type AgentWebhookEvent = Extract<WebhookEvent, `agent.${string}`>;

/**
 * What `agent.bookable_changed` stores on its delivery (#2085).
 *
 * `user_id` is the stable key a send reads the agent's CURRENT state by (see
 * `payloadForSend`); `email` is who Regal is told about, and is what the body's
 * `userId` carries. `slate_bookable` is the value this delivery states: recorded
 * at the change, and rewritten on each send to what that send actually said.
 */
export interface AgentBookablePayload {
  user_id: string;
  email: string;
  slate_bookable: boolean;
}

/** The payload a given event carries, so a caller cannot pair the wrong two. */
export type WebhookPayloadFor<E extends WebhookEvent> = E extends BookingWebhookEvent
  ? BookingEventPayload
  : AgentBookablePayload;

/** Any stored delivery payload, read back without knowing its event statically. */
export type WebhookPayload = BookingEventPayload | AgentBookablePayload;

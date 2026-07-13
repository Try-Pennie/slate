import { DateTime } from "luxon";
import type { WebhookEvent } from "@/lib/db/types";
import type { BookingEventPayload } from "@/lib/webhooks/types";

/**
 * Builds the Regal event payload directly (replacing the Cal.com -> Regal
 * Pipedream transform). Derived timezone/day/time fields mirror the old
 * moment-based logic. NOTE: Regal journeys must be updated to match the
 * 'Slate Booking …' event names and `eventSource: 'slate'`.
 */

const EVENT_NAMES: Record<WebhookEvent, string> = {
  "booking.created": "Slate Booking Created",
  "booking.rescheduled": "Slate Booking Rescheduled",
  "booking.cancelled": "Slate Booking Cancelled",
  "booking.completed": "Slate Booking Completed",
};

// Normalize daylight/standard variants to a single label, matching the old
// Pipedream component.
const TZ_NORMALIZE: Record<string, string> = {
  EST: "ET",
  EDT: "ET",
  CST: "CT",
  CDT: "CT",
  MST: "MT",
  MDT: "MT",
  PST: "PT",
  PDT: "PT",
  AKST: "AKT",
  AKDT: "AKT",
  HST: "HT",
  HDT: "HT",
};

function tzAbbreviation(timeZone: string): string {
  const abbr = DateTime.now().setZone(timeZone).toFormat("ZZZZ"); // e.g. EST, GMT-5
  if (TZ_NORMALIZE[abbr]) return TZ_NORMALIZE[abbr];

  // Raw offsets (Luxon "GMT-5"/"GMT+5:30" or "-05") -> "UTC-5"/"UTC+5:30".
  const m = abbr.match(/^(?:GMT|UTC)?([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (m) {
    const [, sign, hh, mm] = m;
    const mins = parseInt(mm ?? "0", 10);
    return mins > 0
      ? `UTC${sign}${parseInt(hh, 10)}:${String(mins).padStart(2, "0")}`
      : `UTC${sign}${parseInt(hh, 10)}`;
  }
  return abbr;
}

function nameParts(full: string | null): { first?: string; last?: string } {
  if (!full) return {};
  const parts = full.trim().split(/\s+/);
  return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(" ") : undefined };
}

type OptInTrait =
  | Record<string, never>
  | { voiceOptIn?: { subscribed: boolean }; smsOptIn?: { subscribed: boolean } }
  | { emailOptIn: { subscribed: boolean } };

interface RegalEvent {
  name: string;
  properties: Record<string, unknown>;
  eventSource: string;
  traits: {
    firstName?: string;
    lastName?: string;
    phones?: Record<string, OptInTrait>;
    emails?: Record<string, OptInTrait>;
  };
}

export function buildRegalEvent(
  event: WebhookEvent,
  p: BookingEventPayload,
): RegalEvent {
  const tz = p.timezone;
  const start = DateTime.fromISO(p.starts_at, { zone: tz });
  // This also runs on an admin resend and the dead-letter replay, which rebuild the
  // event from the STORED payload, and payloads written before the routing summary
  // existed have no `routing` key. Degrade to "nothing unusual happened" rather than
  // throwing, or replaying a legacy delivery would fail outright.
  const routing = p.routing ?? {
    empty_pool_fallback: false,
    tier_fallback: false,
    requested_tier: null,
    booked_tier: null,
    rungs_dropped: 0,
  };
  const agentName = p.agent.name ?? "Unknown";
  const { first, last } = nameParts(p.attendee.name);
  const isCreated = event === "booking.created";

  const regal: RegalEvent = {
    name: EVENT_NAMES[event],
    eventSource: "slate",
    properties: {
      type: p.event_type_slug,
      bookingTitle: `${p.event_type} between ${agentName} and ${p.attendee.name ?? "guest"}`,
      eventTitle: p.event_type,
      description: p.event_description,
      startTime: p.starts_at,
      ownerEmail: p.agent.email,
      agentName,
      agentFirstName: agentName.split(" ")[0],
      bookingId: p.booking_id,
      salesforceId: p.salesforce_id,
      bucketCode: p.bucket_code,
      status: p.status === "cancelled" ? "CANCELLED" : "ACCEPTED",
      location: "Phone Call",
      slateBookingDayOfWeek: start.toFormat("cccc"),
      slateBookingTimeZone: tzAbbreviation(tz),
      slateBookingLocalTime: start.toFormat("hh:mm a"),
      slateBookingDate: start.toFormat("yyyy-MM-dd"),
      slateBookingLink: p.manage_url,
      currentDayOfWeek: DateTime.now().setZone("America/New_York").toFormat("cccc"),
      // #492: Regal alerts "Non-Ultra High Team Booking Detected" whenever a booking
      // lands outside the top tier. Slate DELIBERATELY drops a rung when the requested
      // tier has nobody free, so without this every intentional drop looks like a
      // misroute and the alert cries wolf from the day of cutover. Gate the Regal
      // journey on slateTierFallback: true means Slate meant to do this.
      //
      // Sent on every event, not just booking.created: a reassign emits
      // booking.rescheduled and can land the booking on a different tier too.
      slateTierFallback: routing.tier_fallback,
      slateEmptyPoolFallback: routing.empty_pool_fallback,
      slateRequestedTier: routing.requested_tier,
      slateBookedTier: routing.booked_tier,
      slateRungsDropped: routing.rungs_dropped,
    },
    traits: {},
  };

  if (first) regal.traits.firstName = first;
  if (last) regal.traits.lastName = last;

  if (p.attendee.phone) {
    regal.traits.phones = {
      [p.attendee.phone]: isCreated
        ? { voiceOptIn: { subscribed: true }, smsOptIn: { subscribed: true } }
        : {},
    };
  }
  if (p.attendee.email) {
    regal.traits.emails = {
      [p.attendee.email]: isCreated ? { emailOptIn: { subscribed: true } } : {},
    };
  }

  if (event === "booking.rescheduled") {
    regal.properties.rescheduleId = p.booking_id;
    // #326: carry the captured reason + who did it (null if somehow absent).
    regal.properties.rescheduleReason = p.reason?.code ?? null;
    regal.properties.rescheduleReasonDetail = p.reason?.detail ?? null;
    regal.properties.rescheduledBy = p.reason?.initiator ?? null;
  }
  if (event === "booking.cancelled") {
    // #326: real reason/initiator now flow through (was hardcoded null).
    regal.properties.cancellationReason = p.reason?.code ?? null;
    regal.properties.cancellationReasonDetail = p.reason?.detail ?? null;
    regal.properties.cancelledBy = p.reason?.initiator ?? null;
  }

  return regal;
}

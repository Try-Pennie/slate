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
  }
  if (event === "booking.cancelled") {
    regal.properties.cancellationReason = null;
    regal.properties.cancelledBy = null;
  }

  return regal;
}

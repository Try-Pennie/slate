import { DateTime } from "luxon";
import type {
  AgentBookablePayload,
  BookingEventPayload,
  BookingWebhookEvent,
} from "@/lib/webhooks/types";
import { partnerKeysFrom } from "@/lib/booking/partner-keys";

/**
 * Builds the Regal event payload directly (replacing the Cal.com -> Regal
 * Pipedream transform). Derived timezone/day/time fields mirror the old
 * moment-based logic. NOTE: Regal journeys must be updated to match the
 * 'Slate Booking …' event names and `eventSource: 'slate'`.
 */

// Keyed on the BOOKING events only (#2085). An agent trait carries no event name
// at all (Dan confirmed the traits only body on 2026-09-08), so widening this to
// every WebhookEvent would demand a name nothing sends.
const EVENT_NAMES: Record<BookingWebhookEvent, string> = {
  "booking.created": "Slate Booking Created",
  "booking.rescheduled": "Slate Booking Rescheduled",
  "booking.cancelled": "Slate Booking Cancelled",
  "booking.reassigned": "Slate Booking Reassigned",
  "booking.completed": "Slate Booking Completed",
};

// Collapse a zone's two seasonal abbreviations to one label, matching the old
// Pipedream component: EST and EDT are one zone at two times of year, and a
// single "ET" spares the reader working out which one they are looking at.
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

/**
 * Does this zone actually carry two abbreviations across the year? (#2117)
 *
 * This is the collapse's OWN REASON written as a condition, rather than a list
 * of the zones it should skip. A zone that reads the same all year has no pair
 * to collapse, so collapsing it drops information and buys nothing, and for
 * Arizona it buys something worse than nothing: Phoenix is MST every day, so
 * from March to November it sits an hour behind Denver while both used to
 * collapse to "MT". A dialer agent reading "2:00 PM MT" against a Phoenix
 * booking in July is an hour early, and nothing in the payload says which
 * Mountain was meant. Eight months of the year, on the second commonest zone on
 * this roster (28 of 148 schedules on 2026-09-09).
 *
 * Written as the reason rather than as `if (zone === "America/Phoenix")` because
 * Hawaii satisfies it too, and so would any zone that stops observing daylight
 * time (L362, L615). The instant's own year is used rather than a fixed one, so
 * a zone that changes its rules is judged by the rules in force for the booking.
 */
function hasSeasonalForms(at: DateTime): boolean {
  const january = at.set({ month: 1, day: 15 });
  const july = at.set({ month: 7, day: 15 });
  return january.toFormat("ZZZZ") !== july.toFormat("ZZZZ");
}

/**
 * The label for the zone a booking was made in, read AT THE BOOKING'S INSTANT.
 *
 * It used to read `DateTime.now()`, so a booking's label described the moment
 * the webhook was sent rather than the moment being labelled. The collapse hid
 * that completely for every zone it covered, since "ET" is the answer in both
 * seasons, which is why it survived: the defect and the fix render identically
 * on every zone anybody tested (#2117).
 */
function tzAbbreviation(at: DateTime): string {
  const abbr = at.toFormat("ZZZZ"); // e.g. EST, GMT-5
  const collapsed = TZ_NORMALIZE[abbr];
  if (collapsed) return hasSeasonalForms(at) ? collapsed : abbr;

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
  event: BookingWebhookEvent,
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
      slateBookingTimeZone: tzAbbreviation(start),
      // one-time-rule-ok: a Regal payload field, not copy anybody reads.
      // NOT display copy, so deliberately NOT the shared time formatter (#1765).
      // This is a payload field Regal reads, its shape is pinned by
      // scripts/test-regal.ts ("09:00 AM"), and changing it changes a contract
      // with another system rather than a sentence somebody reads.
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
      // Sent on every event, not just booking.created: a reassign (#2368) can
      // land the booking on a different tier too, and so can a reschedule.
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

  // #2659: the two join keys the landing page put on the booking URL, under the
  // GTM/GA4 tagging spec's OWN names (snake case, not camel cased to match the
  // rest of this object: the spec chose them and the warehouse joins on them).
  // Set only when the page had a value. The spec is explicit that the key is
  // LEFT OUT otherwise: never an empty string, never a null key, because either
  // reads as a value to a join. On every event, since every event is a join
  // point. `partnerKeysFrom` tolerates a stored payload with no prefill at all,
  // which an admin resend or the dead letter replay can rebuild from.
  const partner = partnerKeysFrom(p.prefill);
  if (partner.submissionId !== null) regal.properties.sfdc_submission_id = partner.submissionId;
  if (partner.regalProfileId !== null) regal.properties.regal_profile_id = partner.regalProfileId;

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
  if (event === "booking.reassigned") {
    // #2368: the call moved advisor and NOT time. Both ends are named so a Regal
    // journey can say who is taking the call now without looking the booking up,
    // and the reason is what lets it tell an owner move from a coverage move: the
    // two are the same shape and mean opposite things to a lead.
    regal.properties.assignedAgentEmail = p.agent.email;
    regal.properties.assignedAgentName = agentName;
    // `?? null` rather than the raw read: a payload written before this field
    // existed (an admin resend, the dead letter replay, an outbox row resuming
    // across the deploy) has no key at all, and undefined is DROPPED from the
    // serialized body, so the consumer would be taught the field is optional
    // (L505, L167). Null says we do not know, which is the truth.
    regal.properties.previousAgentEmail = p.previous_agent_email ?? null;
    regal.properties.reassignReason = p.reason?.code ?? null;
    regal.properties.reassignReasonDetail = p.reason?.detail ?? null;
    regal.properties.reassignedBy = p.reason?.initiator ?? null;
  }
  if (event === "booking.cancelled") {
    // #326: real reason/initiator now flow through (was hardcoded null).
    regal.properties.cancellationReason = p.reason?.code ?? null;
    regal.properties.cancellationReasonDetail = p.reason?.detail ?? null;
    regal.properties.cancelledBy = p.reason?.initiator ?? null;
  }

  return regal;
}

/** The body Regal receives for an agent trait (#2085). */
export interface RegalTraitsBody {
  userId: string;
  traits: { slateBookable: boolean };
}

/**
 * The traits only body for `agent.bookable_changed`, exactly
 * `{"userId": <email>, "traits": {"slateBookable": <bool>}}`.
 *
 * No `name`, no `properties`, no `eventSource`: every other delivery to this URL
 * is an event, and this one is a profile update, which is the shape Dan confirmed
 * on 2026-09-08. Built from the payload a send has just resolved, never from what
 * was recorded, so it states the agent's state at the moment of that send.
 */
export function buildRegalTraits(p: AgentBookablePayload): RegalTraitsBody {
  return { userId: p.email, traits: { slateBookable: p.slate_bookable } };
}

import { DateTime } from "luxon";
import type {
  AgentBookablePayload,
  BookingEventPayload,
  BookingWebhookEvent,
} from "@/lib/webhooks/types";
import { partnerKeysFrom } from "@/lib/booking/partner-keys";
import { lastNameAfter } from "@/lib/attendee";

/**
 * Builds the Regal event payload directly (replacing the Cal.com -> Regal
 * Pipedream transform). Derived timezone/day/time fields mirror the old
 * moment-based logic.
 *
 * EVERY NAME THIS FILE SENDS IS AN EXTERNAL CONTRACT (#2314): the event names,
 * `eventSource`, each property key and the trait keys. Regal journeys trigger on
 * the event name and branch on property keys, and Regal templates merge
 * properties into what a lead reads. Nothing on either side fails when one
 * changes: Slate records a successful delivery, Regal accepts the body, and the
 * journey silently never fires or the template merges an empty string.
 *
 * So the whole wire body is pinned in `regal.test.ts` ("the Regal wire
 * contract"), and a rename, a drop or an addition fails there until the pin is
 * edited. Editing the pin is the moment to do the Regal half too, in the same
 * change: find every journey and template that reads the old name (Regal's
 * journey list, and the sweeps in #2308 and #2309), move them to the new one,
 * and for a rename send both names until the Regal side has moved.
 */

// Keyed on the BOOKING events only (#2085). An agent trait carries no event name
// at all (Dan confirmed the traits only body on 2026-09-08), so widening this to
// every WebhookEvent would demand a name nothing sends.
const EVENT_NAMES: Record<BookingWebhookEvent, string> = {
  "booking.created": "Slate Booking Created",
  "booking.rescheduled": "Slate Booking Rescheduled",
  "booking.cancelled": "Slate Booking Cancelled",
  "booking.reassigned": "Slate Booking Reassigned",
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

/**
 * The name traits, from the first name the lead ANSWERED when the booking holds
 * one (#2549), and from splitting the joined name only when it does not.
 *
 * The split is right for "Mary Smith" and wrong for "Mary Jo Smith", and this
 * value is what the confirmation text greets the lead with. It stays as the
 * fallback for the rows that have nothing better: every booking made before the
 * column existed, every booking through the direct API (which takes one name),
 * and every stored payload a resend or replay rebuilds from.
 */
function nameParts(full: string | null, answeredFirst?: string | null): { first?: string; last?: string } {
  const first = answeredFirst?.trim();
  if (first) return { first, last: lastNameAfter(full, first) };
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

/**
 * #2073: the Regal event a booking made through an advisor's own link is sent as.
 * cal.com's personal links send "Client Sync Action" today and live journey 304
 * ("Client Sync - Generate Tasks") is built on it, so these bookings keep that
 * contract at cutover and never trigger the routed "Slate Booking ..." journeys.
 * The name, the three action literals and the property names were read off
 * journey 304 itself. cal.com's personal link sent nothing on a reassign, so it
 * has no entry: `regalSendsNothingFor` keeps it away from Regal entirely.
 */
const CLIENT_SYNC_EVENT = "Client Sync Action";
const CLIENT_SYNC_ACTIONS: Partial<Record<BookingWebhookEvent, string>> = {
  "booking.created": "BOOKING_CREATED",
  "booking.rescheduled": "BOOKING_RESCHEDULED",
  "booking.cancelled": "BOOKING_CANCELLED",
};

/**
 * Whether Regal must receive NOTHING for this event (#2073): an agent link
 * booking's reassign, which cal.com's personal link never reported.
 * Asked per endpoint by the emitter, so other subscribers still get the event.
 */
export function regalSendsNothingFor(event: BookingWebhookEvent, p: Pick<BookingEventPayload, "booking_kind">): boolean {
  return p.booking_kind === "agent_link" && CLIENT_SYNC_ACTIONS[event] === undefined;
}

/** The contact identity envelope every booking event carries, so the profile matches. */
function contactTraits(p: BookingEventPayload, isCreated: boolean): RegalEvent["traits"] {
  const traits: RegalEvent["traits"] = {};
  const { first, last } = nameParts(p.attendee.name, p.attendee.first_name);
  if (first) traits.firstName = first;
  if (last) traits.lastName = last;
  if (p.attendee.phone) {
    traits.phones = {
      [p.attendee.phone]: isCreated
        ? { voiceOptIn: { subscribed: true }, smsOptIn: { subscribed: true } }
        : {},
    };
  }
  if (p.attendee.email) {
    traits.emails = {
      [p.attendee.email]: isCreated ? { emailOptIn: { subscribed: true } } : {},
    };
  }
  return traits;
}

function buildClientSyncEvent(event: BookingWebhookEvent, p: BookingEventPayload): RegalEvent {
  const action = CLIENT_SYNC_ACTIONS[event];
  // The emitter never builds one of these (regalSendsNothingFor), so reaching it is
  // a fault: refused rather than guessed, which records the delivery as failed.
  if (!action) throw new Error(`An agent link booking has no Regal event for ${event} (#2073)`);
  const startMs = Date.parse(p.starts_at);
  // parse-ok: an unreadable start is refused, never sent as a date the journey's delays would key on
  if (!Number.isFinite(startMs)) throw new Error("An agent link booking's start could not be read (#2073)");
  return {
    name: CLIENT_SYNC_EVENT,
    eventSource: "slate",
    properties: {
      action,
      // ISO 8601 UTC, the NEW start on a reschedule: journey 304's delays key on it.
      scheduled_at: new Date(startMs).toISOString(),
      agent_email: p.agent.email,
    },
    traits: contactTraits(p, event === "booking.created"),
  };
}

export function buildRegalEvent(
  event: BookingWebhookEvent,
  p: BookingEventPayload,
): RegalEvent {
  if (p.booking_kind === "agent_link") return buildClientSyncEvent(event, p);
  const tz = p.timezone;
  const start = DateTime.fromISO(p.starts_at, { zone: tz });
  const startMs = Date.parse(p.starts_at);
  // parse-ok: an unreadable start is refused, never sent as a date Regal and Salesforce would store
  if (!Number.isFinite(startMs)) throw new Error("A booking's start could not be read, so no Regal event was built");
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
  const isCreated = event === "booking.created";

  const regal: RegalEvent = {
    name: EVENT_NAMES[event],
    eventSource: "slate",
    properties: {
      type: p.event_type_slug,
      bookingTitle: `${p.event_type} between ${agentName} and ${p.attendee.name ?? "guest"}`,
      eventTitle: p.event_type,
      description: p.event_description,
      // Written the way cal.com writes it, "2026-10-02T18:30:00.000Z", rather than
      // the "+00:00" Postgres hands back: Regal copies it into calBookingTimestampString
      // and on into Salesforce's Cal Booking Start Time, which should hold one
      // spelling whichever system booked the call (Dan, 2026-10-02).
      startTime: new Date(startMs).toISOString(),
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
    traits: contactTraits(p, isCreated),
  };

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

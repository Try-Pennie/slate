import { describe, it, expect } from "vitest";
import { buildRegalEvent, regalSendsNothingFor } from "./regal";
import { buildRequest } from "./wire";
import { WEBHOOK_EVENTS, isAgentEvent } from "./events";
import type { BookingEventPayload, RoutingMeta, WebhookPayload } from "./types";
import type { BookingWebhookEvent } from "@/lib/webhooks/types";
import type { WebhookEndpoint, WebhookEvent } from "@/lib/db/types";
import { PARTNER_KEYS } from "@/lib/booking/partner-keys";

// #492: Slate deliberately drops a rung when the requested tier has nobody free, which
// from the outside is indistinguishable from a misroute, which is the exact thing Regal's
// "Non-Ultra High Team Booking Detected" alert fires on. Regal can only stay quiet on an
// intentional drop if the signal actually REACHES it.
//
// That is the bug #776 fixed: Slate stamped the routing summary on its internal payload,
// everyone assumed Regal was receiving it, and `buildRegalEvent` never copied it into the
// Regal properties. Nothing failed. The flag simply never arrived, and the only live
// production endpoint is `format: 'regal'`.
//
// These tests are the regression lock on that contract. If the properties below stop
// being emitted, the alert starts crying wolf on every intentional drop again, so this
// must fail loudly rather than let it go silent a second time.

const NO_ROUTING: RoutingMeta = {
  empty_pool_fallback: false,
  tier_fallback: false,
  requested_tier: null,
  booked_tier: null,
  rungs_dropped: 0,
};

function payload(routing: RoutingMeta = NO_ROUTING): BookingEventPayload {
  return {
    booking_id: "bk-1",
    salesforce_id: "sf-1",
    bucket_code: "420",
    event_type: "Senior Loan Advisor Call",
    event_type_slug: "call",
    event_description: null,
    status: "confirmed",
    starts_at: "2026-07-20T14:00:00.000Z",
    ends_at: "2026-07-20T14:20:00.000Z",
    timezone: "America/New_York",
    agent: { id: "u-1", name: "Amanda Ferguson", email: "aferguson@trypennie.com" },
    attendee: { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567" },
    prefill: {},
    manage_url: "https://slate.trypennie.app/manage/abc",
    reason: null,
    previous_agent_email: null,
    routing,
  };
}

/** An Ultra High lead that landed on Very High because 520 had nobody free. */
const INTENTIONAL_DROP: RoutingMeta = {
  empty_pool_fallback: false,
  tier_fallback: true,
  requested_tier: "520",
  booked_tier: "420",
  rungs_dropped: 1,
};

describe("buildRegalEvent routing properties (#492)", () => {
  it("tells Regal an intentional tier drop was intentional", () => {
    const e = buildRegalEvent("booking.created", payload(INTENTIONAL_DROP));

    // The one property the Regal journey gates on. Without it the alert cannot tell a
    // deliberate drop from a misroute.
    expect(e.properties.slateTierFallback).toBe(true);
    expect(e.properties.slateRequestedTier).toBe("520");
    expect(e.properties.slateBookedTier).toBe("420");
    expect(e.properties.slateRungsDropped).toBe(1);
  });

  it("leaves the flag false on an ordinary booking, so a real misroute still alerts", () => {
    const e = buildRegalEvent("booking.created", payload());

    expect(e.properties.slateTierFallback).toBe(false);
    expect(e.properties.slateRungsDropped).toBe(0);
    expect(e.properties.slateRequestedTier).toBeNull();
    expect(e.properties.slateBookedTier).toBeNull();
  });

  it("keeps an empty-pool fallback distinct from a tier drop", () => {
    // The bucket's own fallback agent took it. That is NOT a tier drop, and collapsing
    // the two would suppress the alert on a case Regal may well still want to hear about.
    const e = buildRegalEvent(
      "booking.created",
      payload({
        empty_pool_fallback: true,
        tier_fallback: false,
        requested_tier: "420",
        booked_tier: "420",
        rungs_dropped: 0,
      }),
    );

    expect(e.properties.slateEmptyPoolFallback).toBe(true);
    expect(e.properties.slateTierFallback).toBe(false);
  });

  // A reassign (booking.reassigned since #2368) can land the booking on a different
  // tier, and so can a reschedule, so the signal has to ride every event, not just
  // the create.
  const EVENTS: BookingWebhookEvent[] = [
    "booking.created",
    "booking.rescheduled",
    "booking.cancelled",
    "booking.reassigned",
  ];
  it.each(EVENTS)("carries the routing summary on %s", (event) => {
    const e = buildRegalEvent(event, payload(INTENTIONAL_DROP));

    expect(e.properties.slateTierFallback).toBe(true);
    expect(e.properties.slateBookedTier).toBe("420");
  });

  // Failure path: an admin resend and the dead-letter replay rebuild the event from the
  // STORED payload, and rows written before #776 have no `routing` key at all. Degrade to
  // "nothing unusual happened" rather than throwing. A replay that crashes is worse than
  // a replay that under-reports.
  it("degrades instead of throwing when replaying a payload written before the routing summary existed", () => {
    const legacy = payload();
    delete (legacy as Partial<BookingEventPayload>).routing;

    const e = buildRegalEvent("booking.created", legacy);

    expect(e.properties.slateTierFallback).toBe(false);
    expect(e.properties.slateEmptyPoolFallback).toBe(false);
    expect(e.properties.slateRungsDropped).toBe(0);
  });
});

// #2659: the two join keys a landing page passes on the booking URL (Pennie's
// GTM/GA4 tagging spec v2, section 3) ride into Regal under the spec's OWN names,
// so the warehouse can tie a booking to a lead's submission and to a call
// platform contact without leaning on GA4. The spec is explicit that a key is
// LEFT OUT when the page has no value: never an empty string, never a null key,
// and never a camel cased twin of the name the spec chose.
describe("buildRegalEvent partner join keys (#2659)", () => {
  const SUBMISSION = "a0G5x00000AbCdEQAU";
  const PROFILE = "rp_01HZY3";
  const withKeys = (prefill: Record<string, string>): BookingEventPayload => ({
    ...payload(),
    prefill,
  });

  it("carries both under the tagging spec's exact names", () => {
    const e = buildRegalEvent(
      "booking.created",
      withKeys({ [PARTNER_KEYS.submissionId]: SUBMISSION, [PARTNER_KEYS.regalProfileId]: PROFILE }),
    );

    expect(e.properties.sfdc_submission_id).toBe(SUBMISSION);
    expect(e.properties.regal_profile_id).toBe(PROFILE);
  });

  const EVENTS: BookingWebhookEvent[] = [
    "booking.created",
    "booking.rescheduled",
    "booking.cancelled",
    "booking.reassigned",
  ];
  it.each(EVENTS)("carries them on %s, since every event is a join point", (event) => {
    const e = buildRegalEvent(
      event,
      withKeys({ [PARTNER_KEYS.submissionId]: SUBMISSION, [PARTNER_KEYS.regalProfileId]: PROFILE }),
    );

    expect(e.properties.sfdc_submission_id).toBe(SUBMISSION);
    expect(e.properties.regal_profile_id).toBe(PROFILE);
  });

  it("leaves a key out entirely when the page had no value, never a null key", () => {
    const e = buildRegalEvent("booking.created", withKeys({ utm_source: "google" }));

    expect(e.properties).not.toHaveProperty("sfdc_submission_id");
    expect(e.properties).not.toHaveProperty("regal_profile_id");
  });

  it("carries the submission id alone when the page had no Regal profile", () => {
    const e = buildRegalEvent("booking.created", withKeys({ [PARTNER_KEYS.submissionId]: SUBMISSION }));

    expect(e.properties.sfdc_submission_id).toBe(SUBMISSION);
    expect(e.properties).not.toHaveProperty("regal_profile_id");
  });

  it("treats an empty or blank value as absent, never sending an empty string", () => {
    const e = buildRegalEvent(
      "booking.created",
      withKeys({ [PARTNER_KEYS.submissionId]: "", [PARTNER_KEYS.regalProfileId]: "   " }),
    );

    expect(e.properties).not.toHaveProperty("sfdc_submission_id");
    expect(e.properties).not.toHaveProperty("regal_profile_id");
  });

  it("trims the value it does send, so a padded id still joins", () => {
    const e = buildRegalEvent("booking.created", withKeys({ [PARTNER_KEYS.submissionId]: `  ${SUBMISSION} ` }));

    expect(e.properties.sfdc_submission_id).toBe(SUBMISSION);
  });

  // Failure path: an admin resend and the dead letter replay rebuild the event
  // from the STORED payload. A row with no prefill bag at all must replay, not
  // crash, and simply carry no keys.
  it("degrades instead of throwing when replaying a payload stored with no prefill", () => {
    const legacy = payload();
    delete (legacy as Partial<BookingEventPayload>).prefill;

    const e = buildRegalEvent("booking.created", legacy);

    expect(e.properties).not.toHaveProperty("sfdc_submission_id");
    expect(e.properties).not.toHaveProperty("regal_profile_id");
  });
});

// #2314: the property names Regal receives are a contract with a system outside
// this repo. Regal journeys trigger on the event `name` and branch on property
// names, and Regal templates merge properties into what a lead reads. A rename,
// a drop or an addition fails on neither side: Slate records a successful
// delivery, Regal accepts the body, and the journey never fires or the template
// merges an empty string (L271).
//
// So the WHOLE body is pinned here, read off the wire request (`buildRequest`,
// then `JSON.parse`) rather than off `buildRegalEvent`, because that is what
// Regal actually gets: the wire layer adds `slateDeliveryId`, and serializing
// drops any key whose value is undefined. Every change to a list below fails
// until it is edited here on purpose, ADDITIONS INCLUDED (the older #779 check
// let an addition through as a console note, which nobody reads): a new property
// is one a journey ought to be told about. When one of these lists changes, the
// Regal side has to change with it, see the note at the top of `regal.ts`.
//
// A key set, deliberately, not a value snapshot: `currentDayOfWeek` embeds today,
// and a snapshot is regenerated with `-u` without anybody reading it.
describe("the Regal wire contract (#2314)", () => {
  const ENDPOINT: WebhookEndpoint = {
    id: "ep-1",
    org_id: "org-1",
    url: "https://events.regalvoice.com/events",
    secret: null,
    events: ["booking.created"],
    format: "regal",
    auth_header: "test-key",
    active: true,
    created_at: "2026-01-01T00:00:00.000Z",
  };

  /** Exactly what Regal receives for one event, as parsed JSON. */
  function wireBody(event: WebhookEvent, p: WebhookPayload): Record<string, unknown> {
    return JSON.parse(buildRequest(ENDPOINT, "dl-1", event, p).body) as Record<string, unknown>;
  }
  const sortedKeys = (o: unknown): string[] => Object.keys(o as Record<string, unknown>).sort();

  /** A routed booking with every optional input present, so every key that can appear does. */
  function fullPayload(): BookingEventPayload {
    return {
      ...payload(INTENTIONAL_DROP),
      attendee: { name: "Jane Doe", first_name: "Jane", email: "jane@example.com", phone: "+15551234567" },
      prefill: { [PARTNER_KEYS.submissionId]: "a0G5x00000AbCdEQAU", [PARTNER_KEYS.regalProfileId]: "rp_01HZY3" },
      reason: { code: "found_better_time", detail: null, initiator: "customer" },
      previous_agent_email: "previous@trypennie.com",
      previous_attendee_phone: "+12155550100",
    };
  }

  // On every routed booking event, grouped by why each one exists.
  const ROUTED_BASE = [
    "type",
    "bookingTitle",
    "eventTitle",
    "description",
    "startTime",
    "ownerEmail",
    "agentName",
    "agentFirstName",
    "bookingId",
    "salesforceId",
    "bucketCode",
    "status",
    "location",
    "slateBookingDayOfWeek",
    "slateBookingTimeZone",
    "slateBookingLocalTime",
    "slateBookingDate",
    "slateBookingLink",
    "currentDayOfWeek",
    // #492: Regal's "Non-Ultra High Team Booking Detected" journey gates on these.
    "slateTierFallback",
    "slateEmptyPoolFallback",
    "slateRequestedTier",
    "slateBookedTier",
    "slateRungsDropped",
    // #32: added by the wire layer, so Regal can dedupe a retried delivery.
    "slateDeliveryId",
  ];
  // #2659: present only when the landing page passed a value (pinned separately below).
  const PARTNER_JOIN_KEYS = ["sfdc_submission_id", "regal_profile_id"];

  const PINNED: Record<BookingWebhookEvent, { name: string; properties: string[] }> = {
    "booking.created": {
      name: "Slate Booking Created",
      properties: [...ROUTED_BASE, ...PARTNER_JOIN_KEYS],
    },
    "booking.rescheduled": {
      name: "Slate Booking Rescheduled",
      properties: [
        ...ROUTED_BASE,
        ...PARTNER_JOIN_KEYS,
        // #326
        "rescheduleId",
        "rescheduleReason",
        "rescheduleReasonDetail",
        "rescheduledBy",
      ],
    },
    "booking.cancelled": {
      name: "Slate Booking Cancelled",
      properties: [
        ...ROUTED_BASE,
        ...PARTNER_JOIN_KEYS,
        // #326
        "cancellationReason",
        "cancellationReasonDetail",
        "cancelledBy",
      ],
    },
    "booking.reassigned": {
      name: "Slate Booking Reassigned",
      properties: [
        ...ROUTED_BASE,
        ...PARTNER_JOIN_KEYS,
        // #2368
        "assignedAgentEmail",
        "assignedAgentName",
        "previousAgentEmail",
        "reassignReason",
        "reassignReasonDetail",
        "reassignedBy",
      ],
    },
    "booking.contact_updated": {
      name: "Slate Booking Contact Updated",
      properties: [
        ...ROUTED_BASE,
        ...PARTNER_JOIN_KEYS,
        // #1512: the number the lead replaced and the one they gave instead.
        "previousPhone",
        "correctedPhone",
      ],
    },
  };
  const BOOKING_EVENTS = Object.keys(PINNED) as BookingWebhookEvent[];
  const withoutJoinKeys = (event: BookingWebhookEvent): string[] =>
    PINNED[event].properties.filter((k) => !PARTNER_JOIN_KEYS.includes(k)).sort();

  it("pins an entry for every booking event Slate emits, so a new event cannot reach Regal unpinned", () => {
    const emitted = WEBHOOK_EVENTS.filter((e) => !isAgentEvent(e)).sort();
    expect([...BOOKING_EVENTS].sort()).toEqual(emitted);
  });

  it.each(BOOKING_EVENTS)("sends %s with exactly the pinned envelope, name and property names", (event) => {
    const body = wireBody(event, fullPayload());

    expect(sortedKeys(body)).toEqual(["eventSource", "name", "properties", "traits"]);
    expect(body.name).toBe(PINNED[event].name);
    expect(body.eventSource).toBe("slate");
    expect(sortedKeys(body.properties)).toEqual([...PINNED[event].properties].sort());
  });

  it.each(BOOKING_EVENTS)("leaves out only the two partner join keys on %s when the page passed none", (event) => {
    const body = wireBody(event, { ...fullPayload(), prefill: {} });

    expect(sortedKeys(body.properties)).toEqual(withoutJoinKeys(event));
  });

  // Failure path: an admin resend and the dead letter replay rebuild from a STORED
  // payload, and an old row may lack `routing`, `prefill`, `previous_agent_email`
  // and `first_name`. The keys Regal keys on must still all be there (null, never
  // absent, because an absent key teaches the consumer the field is optional,
  // L167); only the page's optional join keys drop out.
  it.each(BOOKING_EVENTS)("keeps the pinned key set on %s when replaying a legacy stored payload", (event) => {
    const legacy: Partial<BookingEventPayload> = payload();
    delete legacy.routing;
    delete legacy.prefill;
    delete legacy.previous_agent_email;
    const body = wireBody(event, legacy as BookingEventPayload);

    expect(sortedKeys(body.properties)).toEqual(withoutJoinKeys(event));
  });

  it("sends the identity traits with opt ins on a create only", () => {
    expect(wireBody("booking.created", fullPayload()).traits).toEqual({
      firstName: "Jane",
      lastName: "Doe",
      phones: { "+15551234567": { voiceOptIn: { subscribed: true }, smsOptIn: { subscribed: true } } },
      emails: { "jane@example.com": { emailOptIn: { subscribed: true } } },
    });

    for (const event of BOOKING_EVENTS.filter((e) => e !== "booking.created" && e !== "booking.contact_updated")) {
      expect(wireBody(event, fullPayload()).traits).toEqual({
        firstName: "Jane",
        lastName: "Doe",
        phones: { "+15551234567": {} },
        emails: { "jane@example.com": {} },
      });
    }
  });

  // #1512: Regal applies an event's traits to the contact profile, and journey
  // triggered calls and texts go only to the PRIMARY phone, so the corrected number
  // is named primary. It carries NO opt in: Slate asserts the landing page's consent
  // on the number given there (docs/pii.md), and a number typed on the manage page
  // is not that number.
  it("names the corrected number primary on a contact update, with no opt in asserted", () => {
    expect(wireBody("booking.contact_updated", fullPayload()).traits).toEqual({
      firstName: "Jane",
      lastName: "Doe",
      phones: { "+15551234567": { isPrimary: true } },
      emails: { "jane@example.com": {} },
    });
    const props = wireBody("booking.contact_updated", fullPayload()).properties as Record<string, unknown>;
    expect(props.previousPhone).toBe("+12155550100");
    expect(props.correctedPhone).toBe("+15551234567");
  });

  // Failure path: a stored payload replayed from before the field existed says it
  // does not know the old number (null), rather than dropping the key (L167).
  it("reports an unknown previous number as null on a replayed contact update", () => {
    const legacy: Partial<BookingEventPayload> = fullPayload();
    delete legacy.previous_attendee_phone;
    const props = wireBody("booking.contact_updated", legacy as BookingEventPayload).properties as Record<string, unknown>;

    expect(props).toHaveProperty("previousPhone", null);
  });

  // #2073: an advisor's own link keeps cal.com's "Client Sync Action" contract,
  // read off live journey 304, and its reassign and contact update (#1512), which
  // journey 304 has no action for, reach Regal not at all.
  const CLIENT_SYNC_ACTION: Partial<Record<BookingWebhookEvent, string>> = {
    "booking.created": "BOOKING_CREATED",
    "booking.rescheduled": "BOOKING_RESCHEDULED",
    "booking.cancelled": "BOOKING_CANCELLED",
  };
  it.each(BOOKING_EVENTS)("sends an agent link %s under the pinned Client Sync Action contract", (event) => {
    const p: BookingEventPayload = { ...fullPayload(), booking_kind: "agent_link", routing: null };
    const action = CLIENT_SYNC_ACTION[event];
    if (!action) {
      expect(regalSendsNothingFor(event, p)).toBe(true);
      return;
    }
    const body = wireBody(event, p);

    expect(sortedKeys(body)).toEqual(["eventSource", "name", "properties", "traits"]);
    expect(body.name).toBe("Client Sync Action");
    expect(sortedKeys(body.properties)).toEqual(["action", "agent_email", "scheduled_at", "slateDeliveryId"]);
    expect((body.properties as Record<string, unknown>).action).toBe(action);
  });

  it("sends agent.bookable_changed as exactly the traits only body Dan confirmed (#2085)", () => {
    const body = wireBody("agent.bookable_changed", {
      user_id: "u-1",
      email: "aferguson@trypennie.com",
      slate_bookable: true,
    });

    expect(body).toEqual({ userId: "aferguson@trypennie.com", traits: { slateBookable: true } });
  });

  it("pins every agent event Slate emits, so a new one cannot reach Regal unpinned", () => {
    expect(WEBHOOK_EVENTS.filter((e) => isAgentEvent(e))).toEqual(["agent.bookable_changed"]);
  });
});

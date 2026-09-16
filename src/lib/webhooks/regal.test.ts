import { describe, it, expect } from "vitest";
import { buildRegalEvent } from "./regal";
import type { BookingEventPayload, RoutingMeta } from "./types";
import type { WebhookEvent } from "@/lib/db/types";

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
  const EVENTS: WebhookEvent[] = [
    "booking.created",
    "booking.rescheduled",
    "booking.cancelled",
    "booking.reassigned",
    "booking.completed",
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

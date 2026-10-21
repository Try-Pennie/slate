// Sanity test for the Regal event builder: the VALUES it sends.
// Run: node --experimental-strip-types scripts/test-regal.ts
//
// The full set of NAMES it sends (event names, property keys, trait keys) is
// pinned once, at the wire, in src/lib/webhooks/regal.test.ts ("the Regal wire
// contract", #2314), which replaced the softer #779 key check that lived here.
import { buildRegalEvent, regalSendsNothingFor } from "../src/lib/webhooks/regal.ts";
import type { BookingEventPayload } from "../src/lib/webhooks/types.ts";
import { assert, finish } from "./lib/harness.ts";
import { DateTime } from "luxon";
import { CURATED_ZONES } from "../src/lib/booking/timezones.ts";

const payload: BookingEventPayload = {
  booking_id: "11111111-1111-1111-1111-111111111111",
  salesforce_id: "a04Ui00000HnjwfIAB",
  bucket_code: "411",
  event_type: "Senior Loan Advisor Call",
  event_type_slug: "call",
  event_description: "Twenty minutes with a senior advisor…",
  status: "confirmed",
  starts_at: "2026-06-08T13:00:00.000Z", // 09:00 ET (EDT)
  ends_at: "2026-06-08T13:30:00.000Z",
  timezone: "America/New_York",
  agent: { id: "a", name: "Jane Agent", email: "jane@trypennie.com" },
  attendee: {
    name: "Kristina Kelly",
    email: "kristinakelly17@gmail.com",
    phone: "+12035615295",
  },
  prefill: { xbc: "411", loanRequest: "160000" },
  manage_url: "https://slate.app/booking/manage/tok123",
  reason: null,
  previous_agent_email: null,
  routing: {
    empty_pool_fallback: false,
    tier_fallback: false,
    requested_tier: "Ultra-High-Beyond",
    booked_tier: "Ultra-High-Beyond",
    rungs_dropped: 0,
  },
};

const created = buildRegalEvent("booking.created", payload);

assert(created.name === "Slate Booking Created", "event name maps to Slate Booking Created");
assert(created.eventSource === "slate", "eventSource is slate");
assert(created.properties.type === "call", "type uses the regal_type slug");
assert(created.properties.eventTitle === "Senior Loan Advisor Call", "eventTitle is the event type name");
assert(created.properties.description === payload.event_description, "description carried from event type");
assert(created.properties.ownerEmail === "jane@trypennie.com", "ownerEmail is the agent email");
assert(created.properties.agentName === "Jane Agent", "agentName is the agent full name");
assert(created.properties.bookingId === payload.booking_id, "bookingId is the Slate UUID");
assert(created.properties.salesforceId === "a04Ui00000HnjwfIAB", "salesforceId carried");
assert(created.properties.slateBookingLink === payload.manage_url, "slateBookingLink is manage_url");
assert(created.properties.location === "Phone Call", "location hardcoded to Phone Call");
assert(created.properties.slateBookingTimeZone === "ET", "tz abbreviation normalized to ET");
assert(created.properties.slateBookingDayOfWeek === "Monday", "day of week computed in attendee tz");
assert(created.properties.slateBookingLocalTime === "09:00 AM", "local time 09:00 AM in ET");
assert(created.properties.slateBookingDate === "2026-06-08", "local date in ET");
assert(created.properties.status === "ACCEPTED", "confirmed maps to ACCEPTED");
assert(created.traits.firstName === "Kristina" && created.traits.lastName === "Kelly", "name split into traits");
assert(
  JSON.stringify(created.traits.phones) ===
    JSON.stringify({ "+12035615295": { voiceOptIn: { subscribed: true }, smsOptIn: { subscribed: true } } }),
  "created phone trait has voice+sms opt-in",
);
assert(
  JSON.stringify(created.traits.emails) ===
    JSON.stringify({ "kristinakelly17@gmail.com": { emailOptIn: { subscribed: true } } }),
  "created email trait has email opt-in",
);

const cancelled = buildRegalEvent("booking.cancelled", { ...payload, status: "cancelled" });
assert(cancelled.name === "Slate Booking Cancelled", "cancel event name");
assert(cancelled.properties.status === "CANCELLED", "cancelled maps to CANCELLED");
assert(
  JSON.stringify(cancelled.traits.phones) === JSON.stringify({ "+12035615295": {} }),
  "non-created phone trait has no opt-in",
);
assert("cancelledBy" in cancelled.properties, "cancel includes cancelledBy property");
// No reason on the payload -> the reason properties are null (not omitted).
assert(cancelled.properties.cancellationReason === null, "cancel reason null when payload has none");

// #326: a captured reason flows through to the Regal payload (the consumer).
const cancelledWithReason = buildRegalEvent("booking.cancelled", {
  ...payload,
  status: "cancelled",
  reason: { code: "booked_by_mistake", detail: null, initiator: "customer" },
});
assert(cancelledWithReason.properties.cancellationReason === "booked_by_mistake", "cancel reason code maps to cancellationReason");
assert(cancelledWithReason.properties.cancelledBy === "customer", "cancel initiator maps to cancelledBy");

const resched = buildRegalEvent("booking.rescheduled", { ...payload, status: "rescheduled" });
assert(resched.properties.rescheduleId === payload.booking_id, "reschedule includes rescheduleId");

const reschedWithReason = buildRegalEvent("booking.rescheduled", {
  ...payload,
  status: "rescheduled",
  reason: { code: "found_better_time", detail: "earlier slot opened up", initiator: "customer" },
});
assert(reschedWithReason.properties.rescheduleReason === "found_better_time", "reschedule reason code maps to rescheduleReason");
assert(reschedWithReason.properties.rescheduleReasonDetail === "earlier slot opened up", "reschedule detail maps through");
assert(reschedWithReason.properties.rescheduledBy === "customer", "reschedule initiator maps to rescheduledBy");

// --- #2368: a reassign is its own event, not a reschedule ----------------------
// A reassign moves a booking to another advisor and NEVER moves the time, so
// reaching Regal as `Slate Booking Rescheduled` made every journey listening for a
// time change fire on one that had not happened, and a lead could be told their
// call had moved when it had not. The reason rides along so a journey can tell an
// owner move from a coverage move without a person reading the booking.
{
  const reassigned = buildRegalEvent("booking.reassigned", {
    ...payload,
    status: "rescheduled",
    previous_agent_email: "outgoing@trypennie.com",
    reason: { code: "owner_reassignment", detail: null, initiator: "system" },
  });
  assert(reassigned.name === "Slate Booking Reassigned", "#2368: reassign event name is Slate Booking Reassigned");
  assert(reassigned.eventSource === "slate", "#2368: reassign keeps eventSource slate");
  assert(
    reassigned.properties.assignedAgentEmail === "jane@trypennie.com",
    "#2368: assignedAgentEmail is the advisor the call moved TO",
  );
  assert(
    reassigned.properties.assignedAgentName === "Jane Agent",
    "#2368: assignedAgentName is the advisor the call moved TO",
  );
  assert(
    reassigned.properties.previousAgentEmail === "outgoing@trypennie.com",
    "#2368: previousAgentEmail is the advisor the call moved FROM",
  );
  assert(reassigned.properties.reassignReason === "owner_reassignment", "#2368: reassignReason carries the code");
  assert(reassigned.properties.reassignReasonDetail === null, "#2368: reassignReasonDetail is null, not absent");
  assert(reassigned.properties.reassignedBy === "system", "#2368: reassignedBy carries the initiator");
  // The whole reason the reason is on the payload: an owner move and a coverage
  // move are the same shape and must not read the same to a Regal journey.
  const coverage = buildRegalEvent("booking.reassigned", {
    ...payload,
    status: "rescheduled",
    previous_agent_email: "outgoing@trypennie.com",
    reason: { code: "coverage", detail: "out sick", initiator: "admin" },
  });
  assert(
    coverage.properties.reassignReason === "coverage" &&
      coverage.properties.reassignReasonDetail === "out sick" &&
      coverage.properties.reassignedBy === "admin",
    "#2368: a coverage move is distinguishable from an owner move by the reason alone",
  );
  // It must not ALSO look like a reschedule, or a journey keyed on the reschedule
  // fields would still fire on a booking whose time never moved.
  assert(
    !("rescheduleId" in reassigned.properties) &&
      !("rescheduleReason" in reassigned.properties) &&
      !("rescheduledBy" in reassigned.properties),
    "#2368: a reassign carries none of the reschedule properties",
  );
  // And the reverse: a real reschedule must not pick up the reassign fields.
  assert(
    !("previousAgentEmail" in resched.properties) && !("reassignReason" in resched.properties),
    "#2368: a reschedule carries none of the reassign properties",
  );
}

{
  // Failure path. The previous advisor is read from the reassign's outbox row, so a
  // row enqueued before that field existed (a drain resuming across the deploy) has
  // nothing to read. It must come through as null: a guessed address here names the
  // wrong person to whoever reads the Regal timeline, and the booking row itself
  // already holds the NEW advisor by the time this is built.
  const noPrevious = { ...payload, status: "rescheduled" as const } as Partial<BookingEventPayload>;
  delete noPrevious.previous_agent_email;
  const built = buildRegalEvent("booking.reassigned", noPrevious as BookingEventPayload);
  assert(
    built.properties.previousAgentEmail === null,
    "#2368: an unknown previous advisor is null, never guessed and never undefined",
  );
  assert(
    "previousAgentEmail" in built.properties,
    "#2368: the key is present even when unknown, so a consumer is not taught it is optional",
  );
}

// #492: Regal alerts "Non-Ultra High Team Booking Detected" whenever a booking lands
// outside the top tier. Slate now DELIBERATELY drops a rung when the requested tier
// has nobody free, so every intentional drop looks like a misroute to Regal. Slate
// already stamps the routing summary on the payload, but buildRegalEvent dropped it,
// so the signal never reached Regal and it could not tell an intentional drop from a
// real one. Carry it, so a Regal journey can branch on it and stay quiet.
assert(
  created.properties.slateTierFallback === false,
  "#492: a normal booking reports slateTierFallback false (Regal alerts as usual)",
);
assert(
  created.properties.slateRequestedTier === "Ultra-High-Beyond" &&
    created.properties.slateBookedTier === "Ultra-High-Beyond",
  "#492: the requested and booked tier both ride along",
);

{
  // The whole point: the top tier had nobody free, so routing walked down a rung.
  // This is a healthy outcome, not a misroute, and Regal must be able to see that.
  const dropped = buildRegalEvent("booking.created", {
    ...payload,
    routing: {
      empty_pool_fallback: false,
      tier_fallback: true,
      requested_tier: "Ultra-High-Beyond",
      booked_tier: "High",
      rungs_dropped: 1,
    },
  });
  assert(
    dropped.properties.slateTierFallback === true,
    "#492: an intentional tier drop reports slateTierFallback true (Regal can suppress)",
  );
  assert(
    dropped.properties.slateRequestedTier === "Ultra-High-Beyond" &&
      dropped.properties.slateBookedTier === "High" &&
      dropped.properties.slateRungsDropped === 1,
    "#492: the drop names the tier asked for, the tier booked, and how far it fell",
  );
}

{
  // A different kind of fallback: the pool was empty and the bucket's fallback agent
  // took it. Regal should be able to tell the two apart rather than lumping them.
  const emptyPool = buildRegalEvent("booking.created", {
    ...payload,
    routing: { ...payload.routing, empty_pool_fallback: true },
  });
  assert(
    emptyPool.properties.slateEmptyPoolFallback === true &&
      emptyPool.properties.slateTierFallback === false,
    "#492: an empty-pool fallback is reported separately from a tier drop",
  );
}

{
  // The signal must survive a reassign too: reassign emits booking.rescheduled, and a
  // reassign can land the booking on a different tier than the one originally asked for.
  const resched = buildRegalEvent("booking.rescheduled", {
    ...payload,
    routing: { ...payload.routing, tier_fallback: true, booked_tier: "High", rungs_dropped: 1 },
  });
  assert(
    resched.properties.slateTierFallback === true,
    "#492: the routing signal rides every event, not just booking.created",
  );
}

{
  // Failure path. buildRegalEvent also rebuilds the event from the STORED payload on
  // an admin resend and on the dead-letter replay, and payloads written before the
  // routing summary existed have no `routing` key at all (115 of 227 live rows as of
  // 2026-07-13). Reading it blindly would throw and break the resend of every legacy
  // delivery, so a missing summary must degrade to "nothing unusual happened".
  const legacy = { ...payload } as Partial<BookingEventPayload>;
  delete legacy.routing;

  const replayed = buildRegalEvent("booking.created", legacy as BookingEventPayload);

  assert(
    replayed.properties.slateTierFallback === false &&
      replayed.properties.slateEmptyPoolFallback === false &&
      replayed.properties.slateRungsDropped === 0,
    "#492: a legacy payload with no routing summary replays as 'no fallback' instead of throwing",
  );
  assert(
    replayed.properties.slateRequestedTier === null &&
      replayed.properties.slateBookedTier === null,
    "#492: a legacy payload reports unknown tiers as null, not undefined",
  );
}

// --- Arizona keeps its own label (the collapse must stay unambiguous) --------
//
// EST/EDT collapse to "ET" because they are one zone at two times of year, and
// one label spares the reader decoding which. That reason does NOT extend to a
// zone with no daylight time: Phoenix is MST all year, so in summer it sits an
// hour behind Denver while both collapse to "MT". A dialer agent reading
// "2:00 PM MT" on a Phoenix booking in July is an hour early.
//
// The invariant is not "Arizona is special", it is ONE LABEL MEANS ONE CLOCK:
// two zones may share a label only while they share an offset at that instant.
// Driven over the whole year, so the three weeks when only one of two zones has
// changed its clocks are included rather than assumed away.
const zonedPayload = (timezone: string, startsAt: string): BookingEventPayload => ({
  ...payload,
  timezone,
  starts_at: startsAt,
  ends_at: startsAt,
});

const labelFor = (timezone: string, startsAt: string): string =>
  buildRegalEvent("booking.created", zonedPayload(timezone, startsAt)).properties
    .slateBookingTimeZone as string;

// Summer: Phoenix is MST (-7), Denver is MDT (-6). One label cannot mean both.
{
  const july = "2026-07-15T19:00:00.000Z";
  const phoenix = labelFor("America/Phoenix", july);
  const denver = labelFor("America/Denver", july);
  assert(
    phoenix !== denver,
    `#2117: in July Phoenix and Denver are an hour apart, so their labels differ (got ${phoenix} and ${denver})`,
  );
  assert(phoenix === "MST", `#2117: Phoenix reads MST in July, its real year round abbreviation (got ${phoenix})`);
  assert(denver === "MT", `#2117: Denver still collapses to MT in July (got ${denver})`);
}

// Winter: they ARE the same clock, so sharing "MT" is correct and must survive.
// Without this the fix could pass by giving Arizona a permanent label nobody
// asked for, which is a different answer to a question nobody asked.
{
  const january = "2026-01-15T19:00:00.000Z";
  const phoenix = labelFor("America/Phoenix", january);
  const denver = labelFor("America/Denver", january);
  assert(
    phoenix === "MST" && denver === "MT",
    `#2117: in January Phoenix reads MST and Denver MT (got ${phoenix} and ${denver})`,
  );
}

// The collapse itself is the point of the field and must not be lost: a zone
// that really does keep daylight time reads the same label in both seasons.
for (const [zone, label] of [
  ["America/New_York", "ET"],
  ["America/Chicago", "CT"],
  ["America/Denver", "MT"],
  ["America/Los_Angeles", "PT"],
  ["America/Anchorage", "AKT"],
] as const) {
  const winter = labelFor(zone, "2026-01-15T19:00:00.000Z");
  const summer = labelFor(zone, "2026-07-15T19:00:00.000Z");
  assert(
    winter === label && summer === label,
    `#2117: ${zone} collapses to ${label} in both seasons (got ${winter} and ${summer})`,
  );
}

// Hawaii changes too, from HT to HST, and that is the rule applying rather than
// leaking. Honolulu has one abbreviation all year exactly as Phoenix does, so
// there is no pair to collapse and "HST" is both correct and what Hawaii writes.
// Scoping the rule to Arizona alone would have been an exemption named for one
// case instead of for its reason (L362), and it would go stale the moment another
// zone stops observing daylight time. Measured on 2026-09-09 before shipping
// this: of 148 agent schedules, 0 are in Hawaii or Alaska, and every booking in
// the store is America/New_York, so no live record carries the old label.
{
  const winter = labelFor("Pacific/Honolulu", "2026-01-15T19:00:00.000Z");
  const summer = labelFor("Pacific/Honolulu", "2026-07-15T19:00:00.000Z");
  assert(
    winter === "HST" && summer === "HST",
    `#2117: Honolulu reads HST all year, having no seasonal pair to collapse (got ${winter} and ${summer})`,
  );
}

// The label must describe the BOOKING's instant, not the moment the webhook is
// sent. The collapse hid this: a zone whose two seasonal forms both read "ET"
// looks correct either way. London is not offered in the picker, but the booking
// API accepts any zone string, and it has two forms that do NOT collapse, so it
// tells the two apart. Both directions are asserted in one run on purpose: a
// clock read once can only produce one of these two answers, whatever today is
// (L130).
{
  const winter = labelFor("Europe/London", "2026-01-15T12:00:00.000Z");
  const summer = labelFor("Europe/London", "2026-07-15T12:00:00.000Z");
  assert(
    winter === "GMT" && summer === "UTC+1",
    `#2117: the label is read at the booking's instant, not at send time (got ${winter} and ${summer})`,
  );
}

// The general invariant, swept over every offered zone at every month, so a zone
// added to the picker later cannot reintroduce this quietly.
{
  // Swept over what the picker OFFERS plus what the store actually HOLDS. The
  // curated list alone would miss America/Boise, which is a real stored zone on
  // 9 of 148 schedules, is outside the picker, and collapses to "MT" exactly as
  // Denver does, so it can collide with Phoenix in precisely the same way (L217).
  const SWEPT_ZONES = [
    ...CURATED_ZONES,
    { id: "America/Boise", label: "stored, outside the picker" },
    { id: "America/Indiana/Indianapolis", label: "stored, outside the picker" },
  ];
  let collisions = 0;
  let compared = 0;
  for (let month = 1; month <= 12; month++) {
    const startsAt = DateTime.fromObject(
      { year: 2026, month, day: 15, hour: 19 },
      { zone: "utc" },
    ).toISO() as string;
    const seen = new Map<string, number>();
    for (const z of SWEPT_ZONES) {
      const label = labelFor(z.id, startsAt);
      const offset = DateTime.fromISO(startsAt).setZone(z.id).offset;
      compared++;
      const previous = seen.get(label);
      if (previous !== undefined && previous !== offset) {
        collisions++;
        console.error(`   collision: ${label} means both ${previous / 60}h and ${offset / 60}h in month ${month}`);
      }
      seen.set(label, offset);
    }
  }
  // A sweep that compared nothing would report zero collisions too (L98).
  assert(compared === SWEPT_ZONES.length * 12, `#2117: the sweep really ran (${compared} labels compared)`);
  assert(collisions === 0, `#2117: one label means one clock, every offered zone, every month (${collisions} collisions)`);
}

// #2073: a booking through the advisor's own link reaches Regal as cal.com's
// personal links do today, "Client Sync Action", so live journey 304 ("Client Sync
// - Generate Tasks") keeps working at cutover and no routed journey fires. The
// contract was read off journey 304 itself: the name, the three action literals
// it branches on, scheduled_at (its delays key on it) and agent_email.
{
  const named = { ...payload, booking_kind: "agent_link" as const };
  for (const [event, action] of [
    ["booking.created", "BOOKING_CREATED"],
    ["booking.rescheduled", "BOOKING_RESCHEDULED"],
    ["booking.cancelled", "BOOKING_CANCELLED"],
  ] as const) {
    const e = buildRegalEvent(event, named);
    assert(e.name === "Client Sync Action", `#2073: ${event} is sent as Client Sync Action`);
    assert(e.properties.action === action, `#2073: ${event} carries action ${action}`);
    assert(e.properties.scheduled_at === "2026-06-08T13:00:00.000Z", `#2073: ${event} carries the call start as an ISO UTC instant`);
    assert(e.properties.agent_email === "jane@trypennie.com", `#2073: ${event} carries the advisor's email`);
    assert(Object.keys(e.properties).sort().join(",") === "action,agent_email,scheduled_at", `#2073: ${event} carries only the journey's properties`);
    assert(e.eventSource === "slate", `#2073: ${event} keeps the Slate event source`);
    assert(
      e.traits.emails?.["kristinakelly17@gmail.com"] !== undefined && e.traits.phones?.["+12035615295"] !== undefined,
      `#2073: ${event} keeps the contact identity envelope so the profile still matches`,
    );
  }
  // A reschedule sends the NEW start: the journey's delays key on it.
  const moved = buildRegalEvent("booking.rescheduled", { ...named, starts_at: "2026-06-09T18:30:00+00:00" });
  assert(moved.properties.scheduled_at === "2026-06-09T18:30:00.000Z", "#2073: a reschedule carries the new start, normalised to ISO UTC");
  // The same shape stored by Postgres keeps meaning the same instant.
  // cal.com's personal link sent nothing for these, so there is no event to build.
  for (const event of ["booking.reassigned"] as const) {
    assert(regalSendsNothingFor(event, named), `#2073: an agent link ${event} sends nothing to Regal`);
    assert(!regalSendsNothingFor(event, payload), `#2073: a routed ${event} is still sent`);
  }
  for (const event of ["booking.created", "booking.rescheduled", "booking.cancelled"] as const) {
    assert(!regalSendsNothingFor(event, named), `#2073: an agent link ${event} IS sent`);
  }
  // Routed bookings, and stored payloads predating the field, keep the Slate names.
  assert(buildRegalEvent("booking.created", { ...payload, booking_kind: "routed" }).name === "Slate Booking Created", "#2073: a routed booking keeps Slate Booking Created");
  assert(buildRegalEvent("booking.cancelled", payload).name === "Slate Booking Cancelled", "#2073: a payload with no kind is routed");
  assert(!("slateAgentLink" in buildRegalEvent("booking.created", payload).properties), "#2073: routed events carry no agent link flag");
}



// #2549: the first name is the one the lead ANSWERED, not one Slate worked out.
// The booker asks in two fields (#2362) and the booking stores the first one, so
// "Mary Jo" / "Smith" reaches Regal, and the text message that greets the lead
// from this trait, as Mary Jo. Splitting the joined name gives "Mary", which is
// the defect this exists to end.
{
  const traitsFor = (attendee: BookingEventPayload["attendee"]) =>
    buildRegalEvent("booking.created", { ...payload, attendee }).traits;
  const base = { email: "mj@example.com", phone: "+12035615295" };

  const answered = traitsFor({ ...base, name: "Mary Jo Smith", first_name: "Mary Jo" });
  assert(answered.firstName === "Mary Jo", `#2549: the stored first name reaches Regal whole (got ${answered.firstName})`);
  assert(answered.lastName === "Smith", `#2549: and the last name is what followed it (got ${answered.lastName})`);

  const single = traitsFor({ ...base, name: "Cher", first_name: "Cher" });
  assert(single.firstName === "Cher" && single.lastName === undefined, "#2549: a lead with one name has no last name sent");

  // THE CONTROL: a row written before the column existed (or through the direct
  // API, which takes one name) has nothing stored, and splits exactly as it did.
  const legacy = traitsFor({ ...base, name: "Mary Jo Smith", first_name: null });
  assert(
    legacy.firstName === "Mary" && legacy.lastName === "Jo Smith",
    `#2549: no stored first name still splits as before (got ${legacy.firstName} / ${legacy.lastName})`,
  );
  const stored = traitsFor({ ...base, name: "Mary Jo Smith" });
  assert(
    stored.firstName === "Mary" && stored.lastName === "Jo Smith",
    "#2549: a stored payload predating the field splits as before (resend, dead letter replay)",
  );

  // A stored first name that is not the start of the stored name is two facts that
  // disagree. The answered first name still wins, and no last name is invented
  // from a string it does not begin.
  const disagree = traitsFor({ ...base, name: "Smith Mary", first_name: "Mary" });
  assert(
    disagree.firstName === "Mary" && disagree.lastName === undefined,
    `#2549: a first name the full name does not start with sends no guessed last name (got ${disagree.lastName})`,
  );
}

// startTime is written the way cal.com writes it (Dan, 2026-10-02): ISO UTC with
// milliseconds and a Z, "2026-10-02T18:30:00.000Z". Postgres hands back the same
// instant as "+00:00", which is what Slate used to pass straight through, so Regal and
// Salesforce's Cal Booking Start Time held two spellings of one moment depending on
// which system booked the call.
{
  for (const event of ["booking.created", "booking.rescheduled", "booking.cancelled", "booking.reassigned"] as const) {
    const e = buildRegalEvent(event, { ...payload, starts_at: "2026-10-02T18:30:00+00:00" });
    assert(
      e.properties.startTime === "2026-10-02T18:30:00.000Z",
      `${event} sends startTime in cal.com's format (got ${String(e.properties.startTime)})`,
    );
  }
  // An offset other than UTC is converted, not relabelled.
  const offset = buildRegalEvent("booking.created", { ...payload, starts_at: "2026-10-02T14:30:00-04:00" });
  assert(offset.properties.startTime === "2026-10-02T18:30:00.000Z", "an offset start is converted to the same UTC instant");
  // An unreadable start is refused by name rather than sent as a date nobody can read.
  let refused = "";
  try {
    buildRegalEvent("booking.created", { ...payload, starts_at: "not a date" });
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  assert(refused.includes("start could not be read"), `an unreadable start is refused by name (got "${refused}")`);
}

finish();

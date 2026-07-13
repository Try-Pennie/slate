// Sanity test for the Regal event builder.
// Run: node --experimental-strip-types scripts/test-regal.ts
import { buildRegalEvent } from "../src/lib/webhooks/regal.ts";
import type { BookingEventPayload } from "../src/lib/webhooks/types.ts";
import type { WebhookEvent } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

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

// --- #779: the payload CONTRACT ------------------------------------------------
// Regal's journeys key off exact property names. Renaming or dropping one silently
// breaks a Regal automation, and the breakage is INVISIBLE from Slate's side: Regal
// still returns a 200, so nothing here goes red and nothing alerts. Until now a
// property could be deleted outright and this suite would stay green, because each
// test only asserts the handful of properties it happens to name.
//
// So pin the whole key set. Adding a field is safe (Regal accepts arbitrary JSON in
// `properties` and ignores what it does not use), which is why a NEW key is reported
// as a soft note rather than a failure. Removing or renaming one is a CONTRACT BREAK
// and fails: the rename shows up as a removal plus an addition, so it cannot slip by.
//
// Deliberately a key set, not a value snapshot: the payload embeds today's date
// (`currentDayOfWeek`), so a value snapshot would be flaky, and a snapshot can be
// blindly regenerated with `-u`. Editing this list has to be a conscious act.
const BASE_KEYS = [
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
  // #492: lets Regal suppress its "Non-Ultra High Team Booking Detected" alert on an
  // intentional tier drop. Removing these re-breaks that alert.
  "slateTierFallback",
  "slateEmptyPoolFallback",
  "slateRequestedTier",
  "slateBookedTier",
  "slateRungsDropped",
];

// #326: reschedule and cancel each carry their own reason/initiator fields.
const RESCHEDULE_KEYS = [
  ...BASE_KEYS,
  "rescheduleId",
  "rescheduleReason",
  "rescheduleReasonDetail",
  "rescheduledBy",
];
const CANCEL_KEYS = [
  ...BASE_KEYS,
  "cancellationReason",
  "cancellationReasonDetail",
  "cancelledBy",
];

function checkContract(event: WebhookEvent, expected: string[]) {
  const actual = Object.keys(buildRegalEvent(event, payload).properties);

  const removed = expected.filter((k) => !actual.includes(k));
  assert(
    removed.length === 0,
    `#779 CONTRACT: ${event} still sends every property Regal consumes` +
      (removed.length ? ` (MISSING: ${removed.join(", ")} - a Regal journey keyed on these just broke, silently)` : ""),
  );

  // Additive is safe (Regal ignores unknown properties), so this is a note, not a
  // failure. It exists so a new field is noticed and added to the list on purpose.
  const added = actual.filter((k) => !expected.includes(k));
  if (added.length) {
    console.log(
      `  note: ${event} gained ${added.join(", ")} - safe (Regal ignores unknown props), but add it to the contract list above.`,
    );
  }
}

checkContract("booking.created", BASE_KEYS);
checkContract("booking.completed", BASE_KEYS);
checkContract("booking.rescheduled", RESCHEDULE_KEYS);
checkContract("booking.cancelled", CANCEL_KEYS);

// The top-level envelope matters just as much: Regal routes on `name` and filters on
// `eventSource`, and identity/opt-in ride in `traits`.
for (const event of ["booking.created", "booking.rescheduled", "booking.cancelled", "booking.completed"] as WebhookEvent[]) {
  const built = buildRegalEvent(event, payload);
  assert(
    typeof built.name === "string" && built.name.startsWith("Slate Booking "),
    `#779 CONTRACT: ${event} keeps its 'Slate Booking ...' event name (Regal routes on it)`,
  );
  assert(built.eventSource === "slate", `#779 CONTRACT: ${event} keeps eventSource 'slate' (Regal filters on it)`);
  assert(!!built.traits, `#779 CONTRACT: ${event} keeps its traits envelope (identity + opt-in)`);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

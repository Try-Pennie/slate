// Telling Regal whether Slate can route to an agent (#2085).
//
// The trait is NOT a mirror of the `users.bookable` column. It is the value
// Slate's own routing uses, `isRoutable` (bookable AND not deactivated), so an
// offboarded agent whose flag was somehow left true still reads false. It is
// sent only when that DERIVED value changes across a write, which is what makes
// a retrying automation harmless and what keeps the two silent cases silent:
// a reactivation (deactivated_at cleared, bookable deliberately left false) and
// a bookable flip on a deactivated row.
//
// Three pure pieces are pinned here, each where a mistake would be invisible
// from a green delivery log:
//
//   1. `planTraitEmissions`: every combination of before and after.
//   2. the wire body: exactly {"userId": <email>, "traits": {"slateBookable": b}},
//      with no event name and no properties, dispatched on the event FAMILY and
//      never on the endpoint format.
//   3. `payloadForSend`: a retried or replayed trait states the agent's state at
//      the moment of THAT send, so an older failed delivery retried after a newer
//      one succeeded can never put a stale value back into Regal.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-bookable-trait.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  planTraitEmissions,
  type RoutableStateRow,
} from "../src/lib/bookable/routable-trait.ts";
import { buildRequest } from "../src/lib/webhooks/wire.ts";
import { payloadForSend } from "../src/lib/webhooks/agent-trait.ts";
import { webhookEventFamily } from "../src/lib/webhooks/events.ts";
import type { AgentBookablePayload, BookingEventPayload } from "../src/lib/webhooks/types.ts";
import type { WebhookEndpoint } from "../src/lib/db/types.ts";
import { bookableTraitUnrecordedAlert } from "../src/lib/notify/misc-alert-copy.ts";
import { ALERT_CATALOG } from "../src/lib/notify/alert-catalog.ts";

function row(over: Partial<RoutableStateRow> = {}): RoutableStateRow {
  return {
    id: "u-1",
    org_id: "org-1",
    email: "agent@trypennie.com",
    bookable: false,
    deactivated_at: null,
    is_test: false,
    ...over,
  };
}

const LEFT = "2026-09-20T12:00:00.000Z";

// --- 1. the decision, every combination --------------------------------------

{
  // Each state is (bookable, deactivated). Derived value is bookable && !deactivated.
  const states = [
    { bookable: false, deactivated_at: null },
    { bookable: true, deactivated_at: null },
    { bookable: false, deactivated_at: LEFT },
    { bookable: true, deactivated_at: LEFT },
  ];
  const routable = (s: { bookable: boolean; deactivated_at: string | null }) =>
    s.bookable && s.deactivated_at === null;
  let pairs = 0;
  for (const b of states) {
    for (const a of states) {
      pairs++;
      const out = planTraitEmissions([row(b)], [row(a)]);
      const changed = routable(b) !== routable(a);
      eq(
        out.length,
        changed ? 1 : 0,
        `before ${JSON.stringify(b)} after ${JSON.stringify(a)}: ${changed ? "emits" : "silent"}`,
      );
      if (changed) eq(out[0]?.slateBookable, routable(a), "  and carries the AFTER value");
    }
  }
  eq(pairs, 16, "walked all sixteen before/after pairs");
}

{
  // The two silent cases the issue names, each on its own.
  const reactivation = planTraitEmissions(
    [row({ bookable: false, deactivated_at: LEFT })],
    [row({ bookable: false, deactivated_at: null })],
  );
  eq(reactivation.length, 0, "reactivation (bookable left false) sends nothing");

  const flipOnDeparted = planTraitEmissions(
    [row({ bookable: false, deactivated_at: LEFT })],
    [row({ bookable: true, deactivated_at: LEFT })],
  );
  eq(flipOnDeparted.length, 0, "flipping bookable true on a deactivated row sends nothing");
}

{
  // The positive controls for those silences, in the SAME fixture shape, so a
  // plan that never emitted anything could not pass the two cases above (L159).
  const offboarded = planTraitEmissions(
    [row({ bookable: true, deactivated_at: null })],
    [row({ bookable: false, deactivated_at: LEFT })],
  );
  eq(offboarded.length, 1, "offboarding a routable agent sends");
  eq(offboarded[0]?.slateBookable, false, "  and sends false");
  const madeBookable = planTraitEmissions([row()], [row({ bookable: true })]);
  eq(madeBookable[0]?.slateBookable, true, "making an active agent bookable sends true");
}

{
  // Identity, org and suppression come from the row that was written.
  const [e] = planTraitEmissions(
    [row({ id: "u-9", bookable: true, is_test: true, email: "smoke@trypennie.com", org_id: "org-7" })],
    [row({ id: "u-9", bookable: false, is_test: true, email: "smoke@trypennie.com", org_id: "org-7" })],
  );
  eq(e?.userId, "u-9", "carries the user id");
  eq(e?.email, "smoke@trypennie.com", "carries the email Regal keys the profile on");
  eq(e?.orgId, "org-7", "carries the org the endpoint belongs to");
  eq(e?.suppressed, true, "an is_test agent is recorded as suppressed");
}

{
  // A batch: only the rows whose derived value moved, and never a row the write
  // did not touch (present before, absent after = the compare and swap lost).
  const out = planTraitEmissions(
    [
      row({ id: "a", bookable: true }),
      row({ id: "b", bookable: false }),
      row({ id: "c", bookable: true }),
    ],
    [row({ id: "a", bookable: false, deactivated_at: LEFT }), row({ id: "b", bookable: false, deactivated_at: LEFT })],
  );
  eq(out.map((e) => e.userId).join(","), "a", "a batch emits only the rows whose value changed");

  // A row written with no before reading is sent: telling Regal the current value
  // is the harmless direction, and saying nothing would leave it unknown.
  const orphan = planTraitEmissions([], [row({ id: "z", bookable: true })]);
  eq(orphan.map((e) => e.userId).join(","), "z", "a written row with no before reading is sent");
}

// --- 2. the wire body --------------------------------------------------------

const regalEndpoint = {
  id: "ep-1",
  format: "regal",
  url: "https://events.regalvoice.com/events",
  auth_header: "regal-key",
  secret: "unused-for-regal",
} as unknown as WebhookEndpoint;

const genericEndpoint = {
  id: "ep-2",
  format: "generic",
  url: "https://example.com/hook",
  auth_header: null,
  secret: "s3cret",
} as unknown as WebhookEndpoint;

const trait: AgentBookablePayload = {
  user_id: "u-1",
  email: "agent@trypennie.com",
  slate_bookable: false,
};

{
  const req = buildRequest(regalEndpoint, "d-1", "agent.bookable_changed", trait, "2026-09-24T00:00:00.000Z");
  eq(
    req.body,
    JSON.stringify({ userId: "agent@trypennie.com", traits: { slateBookable: false } }),
    "regal: the traits only body, exactly",
  );
  eq(req.headers.authorization, "regal-key", "regal: the same API key the booking events use");
  eq(req.headers["x-slate-delivery-id"], "d-1", "regal: the delivery id rides the header");
  eq(req.headers["content-type"], "application/json", "regal: json");
  const parsed = JSON.parse(req.body);
  assert(!("name" in parsed) && !("properties" in parsed), "regal: no event name, no properties");

  const on = buildRequest(regalEndpoint, "d-2", "agent.bookable_changed", { ...trait, slate_bookable: true });
  eq(JSON.parse(on.body).traits.slateBookable, true, "regal: true is sent as true");

  // Refuses without a key, the same way a booking delivery does (#600).
  let threw = false;
  try {
    buildRequest({ ...regalEndpoint, auth_header: null } as WebhookEndpoint, "d-3", "agent.bookable_changed", trait);
  } catch {
    threw = true;
  }
  assert(threw, "regal: a trait with no API key is refused, never sent unauthenticated");
}

{
  // The booking family is untouched by the widening.
  const booking = {
    booking_id: "b-1",
    salesforce_id: null,
    bucket_code: "411",
    event_type: "Call",
    event_type_slug: "call",
    event_description: null,
    starts_at: "2026-06-25T13:00:00.000Z",
    ends_at: "2026-06-25T13:20:00.000Z",
    timezone: "America/New_York",
    status: "confirmed",
    agent: { id: "u-1", name: "Agent A", email: "a@trypennie.com" },
    attendee: { name: "Dana Lead", email: null, phone: null },
    prefill: {},
    manage_url: "https://slate.trypennie.app/booking/manage/tok",
    reason: null,
    previous_agent_email: null,
    routing: {
      empty_pool_fallback: false,
      tier_fallback: false,
      requested_tier: null,
      booked_tier: null,
      rungs_dropped: 0,
    },
  } as BookingEventPayload;
  const req = buildRequest(regalEndpoint, "d-4", "booking.created", booking);
  eq(JSON.parse(req.body).name, "Slate Booking Created", "regal: a booking event keeps its Regal event shape");
}

{
  // The generic format carries any family as {event, data}.
  const req = buildRequest(genericEndpoint, "d-5", "agent.bookable_changed", trait, "2026-09-24T00:00:00.000Z");
  const body = JSON.parse(req.body);
  eq(body.event, "agent.bookable_changed", "generic: event named");
  eq(body.data.slate_bookable, false, "generic: data is the stored payload");
}

{
  eq(webhookEventFamily("agent.bookable_changed"), "agent", "family: agent.* is the agent family");
  eq(webhookEventFamily("booking.reassigned"), "booking", "family: booking.* is the booking family");
}

// --- 3. what a send states ---------------------------------------------------

{
  const reads: string[] = [];
  const current = async (id: string) => {
    reads.push(id);
    return { bookable: true, deactivated_at: null };
  };

  // An older delivery recorded false, retried after the agent became routable
  // again: the send states the CURRENT value, true.
  const res = await payloadForSend("agent.bookable_changed", trait, current);
  assert(res.ok, "a trait send resolves");
  if (res.ok) {
    eq((res.payload as AgentBookablePayload).slate_bookable, true, "a retried trait states the value at send time");
    eq((res.payload as AgentBookablePayload).email, trait.email, "  under the email it was recorded for");
  }
  eq(reads.join(","), "u-1", "  read by the stable user id, not the email");

  const departed = await payloadForSend("agent.bookable_changed", { ...trait, slate_bookable: true }, async () => ({
    bookable: true,
    deactivated_at: LEFT,
  }));
  assert(departed.ok && (departed.payload as AgentBookablePayload).slate_bookable === false,
    "a departed row still carrying the flag is sent false");

  const gone = await payloadForSend("agent.bookable_changed", trait, async () => null);
  assert(!gone.ok, "a user row that cannot be found is a failed attempt, not a guess");
  if (!gone.ok) assert(/not found/i.test(gone.reason), "  and says so");

  const broken = await payloadForSend("agent.bookable_changed", trait, async () => {
    throw new Error("connection reset");
  });
  assert(!broken.ok, "a failed read is a failed attempt, never the recorded value sent blind");
  if (!broken.ok) assert(/connection reset/.test(broken.reason), "  carrying the read's own error");

  // A booking payload is sent as recorded and reads nothing.
  reads.length = 0;
  const booking = { booking_id: "b-1" } as unknown as BookingEventPayload;
  const b = await payloadForSend("booking.created", booking, current);
  assert(b.ok && b.payload === booking, "a booking payload is sent exactly as stored");
  eq(reads.length, 0, "  with no read");
}

// --- 4. the page for a trait that was never recorded ------------------------
//
// The one failure the delivery path cannot cover: the change was saved and its
// delivery row was never written, so nothing retries it and the dead letter page
// can never fire. It is an incident about one agent, and its copy must say which
// agent, which way, that the change itself stands, and the one thing that repairs
// it.

{
  const off = bookableTraitUnrecordedAlert("dana.whitfield@trypennie.com", false);
  const on = bookableTraitUnrecordedAlert("ariel.nwosu@trypennie.com", true);
  assert(off.includes("dana.whitfield@trypennie.com"), "unrecorded page: names the agent");
  assert(/is now not bookable/.test(off), "unrecorded page: a false says not bookable");
  assert(/is now bookable/.test(on) && !/not bookable/.test(on), "unrecorded page: a true says bookable, and only that");
  assert(/was saved/.test(off), "unrecorded page: says the change itself stands");
  assert(/nothing will retry it/.test(off), "unrecorded page: says why it needs a person");
  assert(off.includes("pnpm backfill:bookable-trait"), "unrecorded page: names the repair");
  assert(off.includes("tag=bookable-trait"), "unrecorded page: points at where the detail lives");
  assert(!/^Slate\b/.test(off), "unrecorded page: does not open with the app's own name");
  assert(!/[{}]/.test(off), "unrecorded page: carries no raw payload");

  const entry = ALERT_CATALOG.find((e) => e.key === "bookable_trait_unrecorded:*");
  eq(entry?.kind, "incident", "unrecorded page: classified an incident, so it never sends an all-clear");
}

finish();

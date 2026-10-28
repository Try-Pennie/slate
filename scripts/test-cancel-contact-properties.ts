// #4273: a cancelled OLDER booking must not rewrite the Regal contact's Marcia flags.
//
// `buildRegalEvent` writes the contact's flags as top level traits (`slateGhostBooking`, and
// `ai_agent_eligible` on a placeholder call) from whichever booking the event is
// about, and Regal applies an event's traits to the contact. So a cancel of an older
// booking, after a newer one landed, overwrote the newer booking's flags. The cancel's
// notify step now asks the duplicate check's own person lookup whether the customer
// still has another active booking, and STORES the answer on the payload: withheld,
// the contact's properties are left out of the Regal event, on the first send and on
// every resend and replay of that delivery alike.
//
// Driven through the real cancel (`cancelBooking` and its outbox steps) over the shared
// BookingDeps fake, then the stored payload through the real Regal builder.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-cancel-contact-properties.ts
import { cancelBooking } from "../src/lib/booking/orchestration.ts";
import { buildRegalEvent } from "../src/lib/webhooks/regal.ts";
import type { BookingEventPayload } from "../src/lib/webhooks/types.ts";
import type { Booking } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, makeBooking, bucket, eventType, NOW, CR } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const marcia = (over: Partial<Booking> = {}) =>
  makeBooking({ assigned_user_id: "p", agent_name: "Marcia", agent_email: "marcia@x.com", kind: "staff_placed", allow_double_book: true, ...over } as Partial<Booking>);
const routed = (over: Partial<Booking> = {}) => makeBooking({ kind: "routed", ...over } as Partial<Booking>);

async function cancelBeside(old: Booking, others: Booking[] | "throws") {
  const { deps, calls } = makeDeps({
    existing: { booking: old, bucket, eventType },
    ...(others === "throws" ? { personBookingsThrows: true } : { personBookings: others }),
  });
  await cancelBooking(old.manage_token, CR, "customer", deps, NOW);
  const sent = calls.webhooks.find((w) => w.event === "booking.cancelled");
  return { sent, lookups: calls.findActiveBookingsForPerson };
}

/** The stored payload as the Regal builder reads it. */
function regalOf(payload: BookingEventPayload) {
  return buildRegalEvent("booking.cancelled", payload);
}

/** The contact's two flags as top level traits, where Regal files them; null when neither is sent. */
function flagsOf(e: ReturnType<typeof regalOf>): Record<string, unknown> | null {
  const t = e.traits as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("slateGhostBooking" in t) out.slateGhostBooking = t.slateGhostBooking;
  if ("ai_agent_eligible" in t) out.ai_agent_eligible = t.ai_agent_eligible;
  return Object.keys(out).length ? out : null;
}

async function run() {
  const NEWER = { id: "bk-new", manage_token: "tok-new", starts_at: "2026-06-09T13:00:00.000Z", ends_at: "2026-06-09T13:30:00.000Z" };
  for (const [label, old, newer] of [
    ["an old Marcia call replaced by a routed call", marcia(), routed(NEWER)],
    ["an old routed call replaced by a Marcia call", routed(), marcia(NEWER)],
    ["an old Marcia call replaced by a new Marcia call", marcia(), marcia(NEWER)],
  ] as const) {
    const { sent, lookups } = await cancelBeside(old, [newer]);
    assert(sent !== undefined, `${label}: the cancel is still sent to Regal`);
    assert(sent?.payload.contact_properties_withheld === "another-live-booking",
      `${label}: the payload stores that the customer still has a live call (got ${String(sent?.payload.contact_properties_withheld)})`);
    const e = sent ? regalOf(sent.payload) : null;
    assert(e !== null && flagsOf(e) === null,
      `${label}: the Regal event leaves the contact's flags to the newer call (got ${JSON.stringify(e ? flagsOf(e) : null)})`);
    assert(e?.properties.slateGhostBooking === (old.kind === "staff_placed"), `${label}: the event itself still names the cancelled call`);
    assert(lookups[0]?.salesforceId === "sf1" && lookups[0]?.email === "k@x.com", `${label}: asked by the cancelled booking's own person`);
  }

  // CONTROL: a lone booking's cancel still sends the contact's flags, Marcia turned off.
  {
    const { sent } = await cancelBeside(marcia(), []);
    assert(sent?.payload.contact_properties_withheld === undefined, "control: a lone cancel withholds nothing");
    const e = sent ? regalOf(sent.payload) : null;
    assert(JSON.stringify(e ? flagsOf(e) : null) === JSON.stringify({ slateGhostBooking: true, ai_agent_eligible: false }),
      `control: and the contact is told the Marcia call is over (got ${JSON.stringify(e ? flagsOf(e) : null)})`);
    const lone = await cancelBeside(routed(), []);
    assert(JSON.stringify(lone.sent ? flagsOf(regalOf(lone.sent.payload)) : null) === JSON.stringify({ slateGhostBooking: false }),
      "control: a lone routed cancel sends its flag as before");
  }

  // The lookup finding only the cancelled booking itself is not "another" booking.
  {
    const old = marcia();
    const { sent } = await cancelBeside(old, [old]);
    assert(sent?.payload.contact_properties_withheld === undefined, "the cancelled booking found by its own lookup does not count as another live call");
  }

  // The lookup fails: the flags are left out rather than overwritten. Overwriting is the
  // harm that can reach a LIVE call (Marcia switched off on it, or its real owner
  // unassigned at call time); leaving them out costs, at worst, a stale flag on a
  // customer with no call, until their next event rewrites it.
  {
    const { sent } = await cancelBeside(marcia(), "throws");
    assert(sent !== undefined, "a failed lookup never stops the cancel reaching Regal");
    assert(sent?.payload.contact_properties_withheld === "lookup-failed", "and the payload stores that it could not tell, by its own word (L11)");
    assert(sent !== undefined && flagsOf(regalOf(sent.payload)) === null, "and the contact's flags are left out, never overwritten");
  }
}

run().then(finish, (err) => {
  console.error(err);
  process.exit(1);
});

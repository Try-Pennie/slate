// A Marcia move fills the contact the booking is MISSING, through the REAL reschedule
// path (#4006). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-marcia-move-fills-contact.ts
//
// WHAT THIS EXISTS TO STOP. The live proof of 2026-10-22 03:09 UTC (exit 9): the
// Worker looked the lead's email and phone up in Salesforce and logged them as found,
// `attendeeFor` handed them to the booking API on a move, and the moved booking still
// held no email and no phone. The direct API's reschedule arm moved the time and
// dropped the attendee it was given. `scripts/test-mcp-booking-operations.ts` could
// not see it: its stateful fake of the booking service REPLACES the attendee on a
// move, which the real service never did. So here Marcia's operation runs against the
// real `bookViaApi` and the real `rescheduleBooking`, over the shared BookingDeps fake.
//
// THE RULE IT PINS. A move writes a looked up or claimed value only into a field the
// booking does NOT already hold, and never overwrites one it does. The token's claim
// wins over a looked up value when choosing what fills a gap (`attendeeFor`), and that
// is all it wins. A filled number is not a correction the lead typed, so the move's
// `booking.rescheduled` carries it for identity only and never names a replaced number
// (the #4031 consent signal), and no separate contact update is sent.
import { runMarciaOperation, type MarciaAnswer } from "../src/lib/mcp-booking/operations.ts";
import type { MarciaLeadClaims } from "../src/lib/mcp-booking/token-shape.ts";
import { bookViaApi } from "../src/lib/booking/orchestration.ts";
import type { Booking, Bucket } from "../src/lib/db/types.ts";
import { PARTNER_BUCKET_CODE } from "../src/lib/embed/public-test-bucket.ts";
import { makeMarciaFake, type FakeContactAnswer } from "./lib/marcia-fake-service.ts";
import { makeDeps, makeBooking, bucket, eventType } from "./lib/booking-fakes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
// 09:00 to 13:00 in Chicago on 2 June. The lead holds the first; the move takes another.
const SLOTS = [
  "2026-06-02T14:00:00.000Z",
  "2026-06-02T15:00:00.000Z",
  "2026-06-02T16:00:00.000Z",
  "2026-06-02T17:00:00.000Z",
  "2026-06-02T18:00:00.000Z",
];
const LEAD = "00Q000000000000AAA";
const TOKEN = "tok-held";

const SF = { name: "Salesforce Lead Name", firstName: "Salesforce", email: "salesforce.lead@example.com", phone: "+12155550133" };

let nonceSeq = 0;
function claims(over: Partial<MarciaLeadClaims> = {}, ...drop: ("name" | "email" | "phone")[]): MarciaLeadClaims {
  const c: MarciaLeadClaims = {
    iss: "marcia",
    aud: "slate-booking",
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 600,
    nonce: `fill-nonce-${String(++nonceSeq).padStart(8, "0")}`,
    salesforce_id: LEAD,
    bucket_code: "411",
    name: "Token Name",
    email: "token.claim@example.com",
    phone: "+12155550144",
    time_zone: "America/Chicago",
    test: true,
    ...over,
  };
  for (const k of drop) delete c[k];
  return c;
}

/**
 * The lead's held call in the public test bucket, known to both halves: Marcia's fake answers the
 * lookup and the audit, and the real orchestration moves it.
 */
function world(held: Partial<Booking>, contact: { known?: FakeContactAnswer; salesforce?: FakeContactAnswer } = {}) {
  const row = makeBooking({
    id: "seed1",
    manage_token: TOKEN,
    salesforce_id: LEAD,
    external_id: LEAD,
    starts_at: SLOTS[0]!,
    ends_at: "2026-06-02T14:30:00.000Z",
    timezone: "America/Chicago",
    gcal_event_id: "gcal-held",
    ...held,
  });
  const testBucket = { ...bucket, is_test: true } as Bucket;
  const real = makeDeps({ testBucket: true, personBookings: [row], existing: { booking: row, bucket: testBucket, eventType } });
  const marcia = makeMarciaFake({ nowMs: NOW, slots: SLOTS, knownContact: contact.known, leadContact: contact.salesforce });
  marcia.seedBooking({ salesforceId: LEAD, externalId: LEAD, startsAt: SLOTS[0]!, bucketCode: PARTNER_BUCKET_CODE });
  marcia.deps.book = (input) => bookViaApi(input, real.deps);
  return { real, marcia, row };
}

async function move(w: ReturnType<typeof world>, c: MarciaLeadClaims): Promise<MarciaAnswer> {
  const offered = await runMarciaOperation("find_times", {}, c, w.marcia.deps);
  const slot = offered.ok ? (offered.data.times as { slot_id: string }[])[0]?.slot_id : undefined;
  assert(slot !== undefined, "a time is offered to move to");
  return runMarciaOperation("move", { slot_id: slot }, c, w.marcia.deps);
}

const rescheduled = (w: ReturnType<typeof world>) => w.real.calls.webhooks.filter((x) => x.event === "booking.rescheduled");

// --- the live defect: a name only booking, email and phone found in Salesforce -------
{
  const w = world(
    { attendee_name: "Dana Lead", attendee_first_name: "Dana", attendee_email: null, attendee_phone: null },
    { known: { name: "Dana Lead", firstName: "Dana", email: null, phone: null }, salesforce: SF },
  );
  const a = await move(w, claims({}, "name", "email", "phone"));
  assert(a.ok && a.data.outcome === "rescheduled", `the move moves (got ${JSON.stringify(a)})`);
  assert(w.real.calls.commitReschedule.length === 1, "through the real reschedule commit");
  eq(w.row.attendee_email, SF.email, "the moved booking now holds the email found in Salesforce");
  eq(w.row.attendee_phone, SF.phone, "and the phone found in Salesforce");
  eq(w.row.attendee_name, "Dana Lead", "and keeps the name it held");
  const patch = w.real.calls.updateBookingContact[0]?.patch;
  assert(w.real.calls.updateBookingContact.length === 1, "in ONE contact write");
  assert(patch !== undefined && !("attendee_name" in patch), `which never touches the name the booking held (got ${JSON.stringify(patch)})`);
  // The advisor's invite, through the same edit the manage page's correction makes.
  const invite = w.real.calls.updateEventContact[0]?.patch;
  assert(invite?.attendeeEmail === SF.email, `the invite now invites the filled address (got ${JSON.stringify(invite)})`);
  assert(invite?.location !== undefined && invite.location.includes("215"), "and its location names the filled number");
  // Downstream, on the move's own event.
  const sent = rescheduled(w);
  eq(sent.length, 1, "one booking.rescheduled goes out");
  eq(sent[0]?.attendee?.email, SF.email, "carrying the filled email");
  eq(sent[0]?.attendee?.phone, SF.phone, "and the filled phone");
  eq(sent[0]?.previousPhone, undefined, "and naming no replaced number: a filled number is not a correction, so Regal gets it for identity only");
  eq(w.real.calls.webhooks.filter((x) => x.event === "booking.contact_updated").length, 0, "and no separate contact update is sent");
}

// --- the token's claim fills a gap ahead of a looked up value ------------------------
{
  const w = world({ attendee_name: "Dana Lead", attendee_email: null, attendee_phone: "+12155550100" }, { salesforce: SF });
  const c = claims({}, "name", "phone");
  const a = await move(w, c);
  assert(a.ok, "a move with a claimed email moves");
  eq(w.row.attendee_email, c.email, "the missing email is filled from the token's claim");
  eq(w.row.attendee_phone, "+12155550100", "and the phone the booking held is kept");
}

// --- THE CONTROL: a booking that holds everything is never overwritten ---------------
//
// Without it, a version that wrote the whole attendee on every move would pass the
// cases above, and a move would replace the number the lead booked with whatever the
// token or Salesforce says (L1).
{
  const w = world(
    { attendee_name: "Dana Lead", attendee_email: "held@example.com", attendee_phone: "+12155550100" },
    { salesforce: SF },
  );
  const a = await move(w, claims());
  assert(a.ok && a.data.outcome === "rescheduled", "the move moves");
  eq(w.real.calls.updateBookingContact.length, 0, "and writes no contact at all: the booking held every field");
  eq(w.real.calls.updateEventContact.length, 0, "so the invite is not rewritten");
  eq(w.row.attendee_email, "held@example.com", "the held email is not replaced by the token's");
  eq(w.row.attendee_phone, "+12155550100", "nor the held phone");
  eq(rescheduled(w)[0]?.attendee?.email, "held@example.com", "and downstream hears the details the booking held");
}

// --- a fill value the invite refuses never stops the move ----------------------------
//
// A looked up value was never typed by the lead, so a refusal of it is not theirs to
// fix: the move goes ahead without it rather than failing over a value nobody gave.
{
  const w = world({ attendee_name: "Dana Lead", attendee_email: null, attendee_phone: null }, { salesforce: { ...SF, phone: "12" } });
  const a = await move(w, claims({}, "name", "email", "phone"));
  assert(a.ok && a.data.outcome === "rescheduled", `a move whose looked up phone is unusable still moves (got ${JSON.stringify(a)})`);
  eq(w.row.attendee_email, SF.email, "with the usable email filled");
  eq(w.row.attendee_phone, null, "and the unusable phone left out");
}

finish();

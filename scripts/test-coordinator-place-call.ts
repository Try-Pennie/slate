// The coordinator page's place a call operation (#4205), through hand written fakes.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coordinator-place-call.ts
//
// What it must hold:
//   - the customer is RE-READ from Salesforce on every submit: the zone, bucket and
//     contact details sent to the booking come from the Lead, never from the page;
//   - the submission id is the page's when it sent a valid one, minted otherwise, and
//     always handed back, so a retry of the same press books once;
//   - a confirmed move carries a reason the reschedule options allow;
//   - every outcome of `placeBookingForCoordinator` becomes a typed answer with its own
//     sentence, and every error it throws becomes a named refusal, never a raw message.
// Every value is invented.
import { placeCall, type PlaceCallDeps } from "../src/lib/coordinator/place-call.ts";
import type { Customer, FoundCustomer } from "../src/lib/coordinator/customer.ts";
import {
  PlacedBookingRefusedError,
  type PlacedBookingInput,
  type PlacedBookingOutcome,
} from "../src/lib/booking/placed-booking.ts";
import {
  ExistingCallCheckUnavailableError,
  NoEligibleAgentsError,
  OutsideCallingWindowError,
  RescheduleConflictError,
  UnknownBucketError,
  VerifyUnavailableError,
} from "../src/lib/booking/orchestration.ts";
import { AttendeeEmailRefusedError } from "../src/lib/booking/attendee-email-refused.ts";
import type { Booking } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SUBMISSION = "6f1c2d3e-0000-4000-8000-000000000001";
const MINTED = "6f1c2d3e-0000-4000-8000-0000000000ff";
const START = "2026-06-09T17:00:00.000Z";
const CUSTOMER: Customer = {
  salesforceLeadId: "00QUi00000AbCdEMAC",
  name: "Invented Customer",
  firstName: "Invented",
  email: "invented.customer@example.com",
  phone: "+15555550100",
  zone: "America/Phoenix",
  zoneFrom: "zip",
  bucketCode: "412",
  bucketSource: "salesforce",
  bucketIsTest: false,
  durationMin: 30,
};
const booking = (over: Partial<Booking> = {}) =>
  ({ id: "bk1", starts_at: START, agent_name: "Advisor A", kind: "routed", manage_token: "tok1", timezone: "America/Phoenix", ...over }) as unknown as Booking;

function fake(f: { found?: FoundCustomer; answer?: PlacedBookingOutcome; throws?: () => unknown } = {}) {
  const placed: PlacedBookingInput[] = [];
  const references: string[] = [];
  const deps: PlaceCallDeps = {
    findCustomer: async (reference) => {
      references.push(reference);
      return f.found ?? { ok: true, customer: CUSTOMER };
    },
    place: async (input) => {
      placed.push(input);
      if (f.throws) throw f.throws();
      return f.answer ?? { kind: "booked", on: "advisor", booking: booking(), manageUrl: "https://slate.test/booking/manage/tok1", replayed: false };
    },
    rescheduleReasons: async () => [
      { code: "schedule_conflict", label: "Schedule conflict" },
      { code: "other", label: "Other" },
    ] as never,
    mintSubmissionId: () => MINTED,
  };
  return { deps, placed, references };
}

const coordinator = { id: "coord-1" };

async function run() {
  {
    const { deps, placed, references } = fake();
    const out = await placeCall({ reference: "https://x/lightning/r/Lead/00QUi00000AbCdE/view", startIso: START, submissionId: SUBMISSION }, coordinator, deps);
    assert(out.kind === "booked" && out.on === "advisor" && out.submissionId === SUBMISSION, `booked with an advisor, under the page's submission id (got ${out.kind})`);
    eq(references, ["https://x/lightning/r/Lead/00QUi00000AbCdE/view"], "the customer is read from Salesforce on the submit itself");
    const p = placed[0];
    eq(
      [p?.salesforceLeadId, p?.bucketCode, p?.timezone, p?.coordinatorUserId, p?.submissionId, p?.startIso],
      [CUSTOMER.salesforceLeadId, "412", "America/Phoenix", "coord-1", SUBMISSION, START],
      "the booking is placed in the Lead's own zone and bucket, as the signed in coordinator",
    );
    eq(p?.attendee, { name: CUSTOMER.name, firstName: CUSTOMER.firstName, email: CUSTOMER.email, phone: CUSTOMER.phone }, "with the Lead's contact details");
    assert(out.kind === "booked" && /Advisor A/.test(out.sentence) && /Arizona/.test(out.sentence), "and says who has it, in the customer's clock");
  }
  {
    const { deps, placed } = fake();
    const out = await placeCall({ reference: "00QUi00000AbCdEMAC", startIso: START }, coordinator, deps);
    assert(out.submissionId === MINTED && placed[0]?.submissionId === MINTED, "a submit with no id is given one, and handed it back for a retry");
    const bad = fake();
    const kept = await placeCall({ reference: "00QUi00000AbCdEMAC", startIso: START, submissionId: "click-1" }, coordinator, bad.deps);
    assert(kept.submissionId === MINTED, "a submission id that is not one is replaced rather than trusted");
  }
  {
    const { deps } = fake({ answer: { kind: "booked", on: "placeholder", booking: booking({ kind: "staff_placed", agent_name: "Marcia" }), manageUrl: "u", replayed: true } });
    const out = await placeCall({ reference: "00QUi00000AbCdEMAC", startIso: START, submissionId: SUBMISSION }, coordinator, deps);
    assert(out.kind === "booked" && out.on === "placeholder" && out.replayed && /already booked/.test(out.sentence), "a repeat of a press answers the first booking and says so");
  }
  {
    const call = { bookingId: "bk0", startsAt: "2026-06-10T17:00:00.000Z", timezone: "America/Phoenix", advisorName: "Advisor B", onPlaceholder: false };
    const { deps } = fake({ answer: { kind: "existing-call", call } });
    const out = await placeCall({ reference: "00QUi00000AbCdEMAC", startIso: START, submissionId: SUBMISSION }, coordinator, deps);
    assert(out.kind === "needs-confirm" && out.call.bookingId === "bk0" && /Confirm/.test(out.sentence), "an existing call asks to be confirmed");
    const loose = fake({ answer: { kind: "possible-match", call, matchedOn: "email-or-phone" } });
    const lo = await placeCall({ reference: "00QUi00000AbCdEMAC", startIso: START, submissionId: SUBMISSION }, coordinator, loose.deps);
    assert(lo.kind === "possible-match" && lo.matchedOn === "email-or-phone", "a looser match is shown as one");
  }
  {
    const { deps, placed } = fake({ answer: { kind: "moved", on: "advisor", booking: booking(), manageUrl: "u" } });
    const out = await placeCall({ reference: "00QUi00000AbCdEMAC", startIso: START, submissionId: SUBMISSION, move: { bookingId: "bk0", reasonCode: "schedule_conflict" } }, coordinator, deps);
    assert(out.kind === "moved" && /Moved/.test(out.sentence), "a confirmed move answers moved");
    eq(placed[0]?.move, { bookingId: "bk0", reason: { code: "schedule_conflict", detail: null } }, "carrying the validated reason");
    const bad = fake();
    const refused = await placeCall({ reference: "00QUi00000AbCdEMAC", startIso: START, submissionId: SUBMISSION, move: { bookingId: "bk0", reasonCode: "made_up" } }, coordinator, bad.deps);
    assert(refused.kind === "refused" && refused.reason === "reason-invalid" && bad.placed.length === 0, "a reason the options do not allow is refused before anything moves");
    const noDetail = fake();
    const nd = await placeCall({ reference: "00QUi00000AbCdEMAC", startIso: START, submissionId: SUBMISSION, move: { bookingId: "bk0", reasonCode: "other" } }, coordinator, noDetail.deps);
    assert(nd.kind === "refused" && nd.reason === "reason-invalid", "and so is Other with nothing said");
  }
  {
    const { deps, placed } = fake({ found: { ok: false, refusal: "zone-unknown" } });
    const out = await placeCall({ reference: "00QUi00000AbCdEMAC", startIso: START, submissionId: SUBMISSION }, coordinator, deps);
    assert(out.kind === "refused" && out.reason === "zone-unknown" && !out.retryable && placed.length === 0, "a customer the lookup refuses is never booked");
  }
  const errors: [string, () => unknown, string, boolean][] = [
    ["the placeholder switch off", () => new PlacedBookingRefusedError("switch-off"), "switch-off", false],
    ["Pennie closed", () => new PlacedBookingRefusedError("outside-business-hours"), "outside-business-hours", false],
    ["outside the customer's window", () => new OutsideCallingWindowError("America/Phoenix"), "outside-calling-window", false],
    ["an unknown bucket", () => new UnknownBucketError(), "no-bucket", false],
    ["the existing call unreadable", () => new ExistingCallCheckUnavailableError(), "existing-call-unreadable", true],
    ["a move in flight", () => new RescheduleConflictError(), "move-conflict", false],
    ["a calendar outage", () => new VerifyUnavailableError(), "calendar-unavailable", true],
    ["the email refused", () => new AttendeeEmailRefusedError(new Error("invalid attendee")), "attendee-email-refused", false],
    ["nobody at all", () => new NoEligibleAgentsError(), "no-advisor", false],
    ["an unexpected fault", () => new Error("connection reset by peer"), "internal", true],
  ];
  for (const [label, err, reason, retryable] of errors) {
    const { deps } = fake({ throws: err });
    const out = await placeCall({ reference: "00QUi00000AbCdEMAC", startIso: START, submissionId: SUBMISSION }, coordinator, deps);
    assert(out.kind === "refused" && out.reason === reason && out.retryable === retryable, `${label} is refused as ${reason} (got ${out.kind === "refused" ? out.reason : out.kind})`);
    assert(out.submissionId === SUBMISSION, `${label}: the same submission id comes back, so a retry books once`);
    assert(!/connection reset|Error:/.test(out.sentence), `${label}: the sentence carries no raw error`);
  }
  {
    const { deps } = fake({ throws: () => new OutsideCallingWindowError("America/Phoenix") });
    const out = await placeCall({ reference: "00QUi00000AbCdEMAC", startIso: START, submissionId: SUBMISSION }, coordinator, deps);
    assert(out.kind === "refused" && /Arizona/.test(out.sentence) && /8:00am and 8:00pm/.test(out.sentence), "the calling window refusal names the window and the customer's zone");
  }
}

run().then(finish, (err) => {
  console.error(err);
  process.exit(1);
});

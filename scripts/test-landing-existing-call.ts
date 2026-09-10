// The lead is known from the FIRST render on a link that carries their id (#2166).
// Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-landing-existing-call.ts
//
// WHAT THIS EXISTS TO STOP. Seen on the 2026-09-09 pilot booking: a lead who
// already had a call reopened `/booking/{salesforceId}` expecting to be told so,
// and got the ordinary time picker. The notice only appears at Confirm, after a
// time is picked and a form is filled, when the book call answers 409.
//
// That sequencing was reasoned from the plain `/book?xbc=` link, where nothing
// identifies the lead until they submit. It does not hold here: the path carries
// the Salesforce id, which `person-dedupe` grades as a STRONG match, the same
// identity that recognises them at Confirm.
//
// ONE GRADER, asked twice. The landing and the confirm must not be two opinions
// about who may be shown a booking, because the looser one would decide (#1340,
// L70). So this drives the SHIPPED grader through the landing entry point and
// asserts the same disclosure rule holds.
import { findExistingCallForIdentity } from "../src/lib/booking/orchestration.ts";
import { createAsserter, makeDeps, makeBooking } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const SF_ID = "003xx000004TmiQAAS";
const EMAIL = "dana@example.com";
const PHONE = "(215) 555-0100";

function world(bookingOverrides: Partial<ReturnType<typeof makeBooking>> = {}) {
  const booking = makeBooking({
    id: "bk-1",
    manage_token: "tok-existing",
    starts_at: "2026-10-01T15:00:00.000Z",
    salesforce_id: SF_ID,
    attendee_email: EMAIL,
    attendee_phone: PHONE,
    ...bookingOverrides,
  });
  return makeDeps({ personBookings: [booking] });
}

async function run() {
  // --- the id in the path is enough, and it discloses --------------------------
  {
    const { deps } = world();
    const call = await findExistingCallForIdentity(
      { salesforceId: SF_ID, externalId: null, email: null, phone: null },
      deps,
    );
    assert(call !== null, "a lead whose id matches an active call is recognised on landing");
    assert(call?.disclose === true, "and the id is a strong match, so the call is named");
    assert(
      call?.disclose === true && call.startsAt === "2026-10-01T15:00:00.000Z",
      "with the time they already have",
    );
    assert(
      call?.disclose === true && call.manageToken === "tok-existing",
      "and the token that lets them act on it",
    );
  }

  {
    // NO email and NO phone are supplied at landing, because the lead has typed
    // nothing yet. The identity is the link alone, and that has to be enough or
    // the whole notice is unreachable on the very screen it is for.
    //
    // The external id is a SEPARATE column from the Salesforce one, which is why
    // `/book?external_id=` asks this as `salesforceId`: the Booker takes that
    // parameter into its `salesforceId` prop and the confirm posts it under that
    // name, so the booking is written with it in `salesforce_id`. Asking it here
    // as `externalId` would query the column the booking does not carry, and the
    // landing and the confirm would disagree about the same lead.
    const { deps } = world({ external_id: "ext-9", salesforce_id: null });
    const byExternal = await findExistingCallForIdentity(
      { salesforceId: null, externalId: "ext-9", email: null, phone: null },
      deps,
    );
    assert(byExternal !== null, "a booking carrying an external id is recognised by it");
    const byWrongField = await findExistingCallForIdentity(
      { salesforceId: "ext-9", externalId: null, email: null, phone: null },
      deps,
    );
    assert(
      byWrongField === null,
      "and the two ids are different columns, which is why the caller must ask with the field the confirm will send",
    );
  }

  // --- somebody the link does not identify -------------------------------------
  {
    const { deps } = world();
    const call = await findExistingCallForIdentity(
      { salesforceId: "003-somebody-else", externalId: null, email: null, phone: null },
      deps,
    );
    assert(call === null, "a different id matches nothing, so the ordinary picker is shown");
  }

  {
    // THE CONTROL. An identity with nothing in it must recognise NOBODY: `/book`
    // with no id is the commonest way into the booker, and a grader that matched
    // on emptiness would put a stranger's call in front of every anonymous lead
    // (L1, #1340).
    const { deps } = world();
    const call = await findExistingCallForIdentity(
      { salesforceId: null, externalId: null, email: null, phone: null },
      deps,
    );
    assert(call === null, "an empty identity recognises nobody at all");
  }

  {
    // A lead with no active call at all. The reason the landing check can be
    // silent, and the ordinary case for a first visit.
    const { deps } = makeDeps({ personBookings: [] });
    const call = await findExistingCallForIdentity(
      { salesforceId: SF_ID, externalId: null, email: null, phone: null },
      deps,
    );
    assert(call === null, "no active call means no notice");
  }

  // --- a read that could not be made -------------------------------------------
  {
    // It THROWS here, and the landing caller is the one that swallows it. That
    // asymmetry is deliberate and belongs at the call site: the confirm must
    // refuse, because the harm there is creating a second call; the landing shows
    // the picker, and the confirm still refuses at the end of it.
    const { deps } = makeDeps({ personBookingsThrows: true });
    let thrown: unknown;
    try {
      await findExistingCallForIdentity(
        { salesforceId: SF_ID, externalId: null, email: null, phone: null },
        deps,
      );
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && thrown.name === "ExistingCallCheckUnavailableError",
      `a read it could not make is its own typed refusal (got ${String(thrown)})`,
    );
  }

  // --- the number the advisor will ring, named rather than shown (#2207) -------
  // The panel let a recognised lead move and cancel and not change what we would
  // call, once #2203 took the details form off that path. It names the number so
  // they can tell whether it needs correcting, by its last four digits, because
  // this panel is reached by a LINK and the manage page that shows it in full is
  // reached by the token inside their invite.
  {
    const { deps } = world();
    const call = await findExistingCallForIdentity(
      { salesforceId: SF_ID, externalId: null, email: null, phone: null },
      deps,
    );
    assert(
      call?.disclose === true && call.phoneLast4 === "0100",
      `the call names its number by its last four digits (got ${JSON.stringify(call)})`,
    );
    assert(
      call?.disclose === true && !JSON.stringify(call).includes("555-0100"),
      "and the whole number is never in the payload at all",
    );
  }

  {
    // A booking with no number on it. Null, never an empty string: the panel has
    // to tell "no number here" from "a number ending in nothing", because the
    // first is a sentence it must not write (L11).
    const { deps } = world({ attendee_phone: null });
    const call = await findExistingCallForIdentity(
      { salesforceId: SF_ID, externalId: null, email: null, phone: null },
      deps,
    );
    assert(
      call?.disclose === true && call.phoneLast4 === null,
      `a call carrying no number names none (got ${JSON.stringify(call)})`,
    );
  }

  finish();
}

void run();

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

/** The landing pages ask in the world of the bucket they draw; these cases are all real (#2660). */
const REAL_WORLD = { isTest: false };

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
  // --- #2660: the same grader, asked in the TEST world, carries that world to
  // the read, so a tester who pastes a real lead's id is never shown that lead's
  // call. The filtering itself is the database's (pinned in
  // person-lookup.test.ts); what this pins is that the world the page names is
  // the world the read is asked in.
  {
    const { deps, calls } = makeDeps({ personBookings: [] });
    await findExistingCallForIdentity(
      { salesforceId: SF_ID, externalId: null, email: null, phone: null },
      deps,
      { isTest: true },
    );
    assert(
      calls.personWorlds.length === 1 && calls.personWorlds[0]?.isTest === true,
      "a landing on a test bucket asks the lookup in the test world",
    );
  }

  // --- the id in the path is enough, and it discloses --------------------------
  {
    const { deps, calls } = world();
    const call = await findExistingCallForIdentity(
      { salesforceId: SF_ID, externalId: null, email: null, phone: null },
      deps,
      REAL_WORLD,
    );
    // #2660: the read is scoped to the world the caller named, and nothing here
    // decides that for itself.
    assert(
      calls.personWorlds.length === 1 && calls.personWorlds[0]?.isTest === false,
      "the lookup is asked in the world the landing page named (real)",
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
    // `/book?external_id=` asks this as `salesforceId`, the field the confirm
    // posts. Since #2663 a strong id matches EITHER column, so a booking an API
    // caller made with only `external_id` is recognised at the landing too, and
    // the landing and the confirm still agree, because both grade through the
    // same `findPersonMatch`. Before #2663 this pinned the opposite (the two
    // columns never met), which is the decision that change reversed.
    const { deps } = world({ external_id: "ext-9", salesforce_id: null });
    const byExternal = await findExistingCallForIdentity(
      { salesforceId: null, externalId: "ext-9", email: null, phone: null },
      deps,
      REAL_WORLD,
    );
    assert(byExternal !== null, "a booking carrying an external id is recognised by it");
    const bySalesforceField = await findExistingCallForIdentity(
      { salesforceId: "ext-9", externalId: null, email: null, phone: null },
      deps,
      REAL_WORLD,
    );
    assert(
      bySalesforceField?.disclose === true,
      "and by the same id sent as salesforceId, since a strong id matches either column (#2663)",
    );
    const byStranger = await findExistingCallForIdentity(
      { salesforceId: "ext-other", externalId: null, email: null, phone: null },
      deps,
      REAL_WORLD,
    );
    assert(byStranger === null, "while a different id still finds nothing");
  }

  // --- somebody the link does not identify -------------------------------------
  {
    const { deps } = world();
    const call = await findExistingCallForIdentity(
      { salesforceId: "003-somebody-else", externalId: null, email: null, phone: null },
      deps,
      REAL_WORLD,
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
      REAL_WORLD,
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
      REAL_WORLD,
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
        REAL_WORLD,
      );
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && thrown.name === "ExistingCallCheckUnavailableError",
      `a read it could not make is its own typed refusal (got ${String(thrown)})`,
    );
  }

  // --- the number the advisor will ring, in full (#2213) -----------------------
  // The panel let a recognised lead move and cancel and not change what we would
  // call, once #2203 took the details form off that path. It carries the WHOLE
  // number, so the lead reads back exactly what Slate holds and can tell whether
  // it needs correcting. Dan settled that on 2026-09-10, reversing the four digit
  // version (#2207): the manage page has always shown it in full, and one sentence
  // now serves both surfaces.
  {
    const { deps } = world();
    const call = await findExistingCallForIdentity(
      { salesforceId: SF_ID, externalId: null, email: null, phone: null },
      deps,
      REAL_WORLD,
    );
    assert(
      call?.disclose === true && call.phone === PHONE,
      `the call carries the number in full (got ${JSON.stringify(call)})`,
    );
  }

  {
    // A booking with no number on it. Null, never an empty string: the panel has
    // to tell "no number here" from "a number we will call", because the first is
    // its own sentence and its own control (L11).
    const { deps } = world({ attendee_phone: null });
    const call = await findExistingCallForIdentity(
      { salesforceId: SF_ID, externalId: null, email: null, phone: null },
      deps,
      REAL_WORLD,
    );
    assert(
      call?.disclose === true && call.phone === null,
      `a call carrying no number names none (got ${JSON.stringify(call)})`,
    );
  }

  {
    // And a stored number that is nothing but space is the same screen as no
    // number at all. It reaches the column through the API and through an import,
    // and the panel must not offer to read " " back to the lead as what we hold.
    const { deps } = world({ attendee_phone: "   " });
    const call = await findExistingCallForIdentity(
      { salesforceId: SF_ID, externalId: null, email: null, phone: null },
      deps,
      REAL_WORLD,
    );
    assert(
      call?.disclose === true && call.phone === null,
      `a blank stored number reads as no number (got ${JSON.stringify(call)})`,
    );
  }

  finish();
}

void run();

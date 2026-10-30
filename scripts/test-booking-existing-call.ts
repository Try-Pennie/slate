/**
 * #1337: one call per person is ENFORCED on the public booker, not reported
 * after the fact.
 *
 * The old behaviour created the second booking and returned a
 * `duplicateWarning` the confirmation screen rendered as "Heads up: you already
 * have another call booked", so the product made the duplicate and then asked
 * the lead to tidy it up, leaving the advisor two calls to reconcile. Now the
 * second booking is DECLINED at confirm, before anything is created, and the
 * lead is offered the choice of moving the call they already have.
 *
 * Three things this file pins that are easy to break silently:
 *
 *  - **The refusal is looser than the disclosure.** ANY of salesforce id, email
 *    or phone declines a second booking (Dan, 2026-08-07), but only a strong or
 *    medium match may be SHOWN that booking and handed its manage token (#1340).
 *  - **It runs after the idempotency fast path.** A double-click's second
 *    request must not find the booking its own first request just made and
 *    decline it, which would turn a successful confirm into a refusal.
 *  - **It fails CLOSED (#1641, reversing the original call).** A lookup error
 *    refuses the booking and logs, rather than creating it. The fail-open it
 *    replaces rested on `findDuplicateWarning` telling the lead afterwards, and
 *    that backstop runs the SAME query on the SAME table: when the read is what
 *    failed, it is blind too (L345), so the duplicate reached the advisor with
 *    nobody told. The refusal is a retriable 503 and the rate-limit hit is
 *    refunded, so the cost is a retry rather than the lead's call.
 *
 * Run: node --experimental-strip-types scripts/test-booking-existing-call.ts
 */
import {
  createBooking,
  ExistingCallError,
  ExistingCallCheckUnavailableError,
  findExistingCallForIdentity,
  personIdentityOf,
  type ExistingCall,
} from "../src/lib/booking/orchestration.ts";
import { createAsserter, makeDeps, makeBooking, input } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/** The public booker's input: the only caller that opts into the refusal. */
const bookerInput = { ...input, refuseIfPersonHasCall: true };

/** Run a create and report whether it was declined, plus what it disclosed. */
async function attempt(
  over: Parameters<typeof makeDeps>[0],
  inp = bookerInput,
): Promise<{
  declined: ExistingCall | null;
  created: boolean;
  events: number;
  bookingsWritten: number;
}> {
  const { deps, calls } = makeDeps({
    candidates: ["a"],
    freeEmails: new Set(["a@x.com"]),
    ...over,
  });
  try {
    await createBooking(inp, deps);
    return {
      declined: null,
      created: true,
      events: calls.createEvent.length,
      bookingsWritten: calls.insertBooking.length,
    };
  } catch (err) {
    if (err instanceof ExistingCallError) {
      // A calendar invite is the observable proof a booking happened, so its
      // absence is what "nothing was created" actually means to a lead. The
      // booking row is the other half, and it is written in a separate step.
      return {
        declined: err.existingCall,
        created: false,
        events: calls.createEvent.length,
        bookingsWritten: calls.insertBooking.length,
      };
    }
    throw err;
  }
}

/**
 * The same run, for the case where the LOOKUP ITSELF fails: report whether the
 * refusal was the unavailable one, and what (if anything) got written.
 * Deliberately separate from `attempt`, so a run that threw the ordinary
 * `ExistingCallError` can never be counted as this outcome.
 */
async function attemptUnavailable(
  over: Parameters<typeof makeDeps>[0],
): Promise<{ unavailable: boolean; created: boolean; events: number; bookingsWritten: number }> {
  const { deps, calls } = makeDeps({
    candidates: ["a"],
    freeEmails: new Set(["a@x.com"]),
    ...over,
  });
  try {
    await createBooking(bookerInput, deps);
    return {
      unavailable: false,
      created: true,
      events: calls.createEvent.length,
      bookingsWritten: calls.insertBooking.length,
    };
  } catch (err) {
    if (err instanceof ExistingCallCheckUnavailableError) {
      return {
        unavailable: true,
        created: false,
        events: calls.createEvent.length,
        bookingsWritten: calls.insertBooking.length,
      };
    }
    throw err;
  }
}

async function run() {
  // --- #2660: the gate is asked in the WORLD of the bucket being booked ---
  // A test booking under an address must never refuse the real lead who owns it,
  // and a tester must never be refused because a real lead shares their address.
  // The world is the bucket's own flag, read after the bucket resolves, never a
  // guess from the caller's permission to book test buckets.
  {
    const real = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    await createBooking(bookerInput, real.deps);
    assert(
      real.calls.personWorlds.length === 1 && real.calls.personWorlds[0]?.isTest === false,
      "a confirm on a real bucket asks the person gate in the real world",
    );

    const test = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      testBucket: true,
    });
    await createBooking({ ...bookerInput, allowTestBuckets: true }, test.deps);
    assert(
      test.calls.personWorlds.length === 1 && test.calls.personWorlds[0]?.isTest === true,
      "a confirm on the public test bucket asks the person gate in the test world",
    );
  }

  // --- Any single signal declines the second booking ---
  {
    // Salesforce id only: a strong match, so the call may be named.
    const r = await attempt({
      personBookings: [
        makeBooking({
          id: "bk-old",
          salesforce_id: "sf1",
          attendee_email: "someone-else@x.com",
          attendee_phone: null,
          starts_at: "2026-06-09T18:00:00.000Z",
          manage_token: "tok-old",
          assigned_user_id: "a",
        }),
      ],
      agentNames: { a: "Aisha Bello" },
    });
    assert(!r.created, "a salesforce id match declines the second booking");
    assert(r.events === 0, "salesforce match: no calendar invite, so nothing was created");
    assert(
      r.declined?.disclose === true &&
        r.declined.startsAt === "2026-06-09T18:00:00.000Z" &&
        r.declined.advisorName === "Aisha Bello" &&
        r.declined.manageToken === "tok-old",
      "a strong match names the call, its advisor and its manage token",
    );
  }

  {
    // Email only: a WEAK match. Still declined, but reveals nothing.
    const r = await attempt({
      personBookings: [
        makeBooking({
          id: "bk-old",
          salesforce_id: null,
          attendee_email: "k@x.com",
          attendee_phone: "+12225550000",
          manage_token: "tok-old",
        }),
      ],
      agentNames: { a: "Aisha Bello" },
    });
    assert(!r.created, "an email-only match still declines the second booking");
    assert(r.events === 0, "email-only match: no calendar invite, so nothing was created");
    assert(r.declined?.disclose === false, "an email-only match discloses nothing");
    assert(
      !JSON.stringify(r.declined).includes("tok-old") &&
        !JSON.stringify(r.declined).includes("Aisha"),
      "a weak match carries neither the manage token nor the advisor's name",
    );
  }

  {
    // Phone only: also weak (a shared household phone).
    const r = await attempt({
      personBookings: [
        makeBooking({
          id: "bk-old",
          salesforce_id: null,
          attendee_email: "housemate@x.com",
          attendee_phone: "+12035615295",
          manage_token: "tok-old",
        }),
      ],
    });
    assert(!r.created, "a phone-only match still declines the second booking");
    assert(r.declined?.disclose === false, "a phone-only match discloses nothing");
  }

  {
    // Email AND phone: medium, so it may be disclosed.
    const r = await attempt({
      personBookings: [
        makeBooking({
          id: "bk-old",
          salesforce_id: null,
          attendee_email: "k@x.com",
          attendee_phone: "+12035615295",
          manage_token: "tok-old",
          assigned_user_id: "a",
        }),
      ],
      agentNames: { a: "Aisha Bello" },
    });
    assert(
      r.declined?.disclose === true && r.declined.manageToken === "tok-old",
      "email AND phone together is enough to name the call and hand over its token",
    );
  }

  // --- #4415: the confirm hands a program lead's call its move token, as the landing does ---
  // A program lead told at confirm that they already have a call opens the same Move panel
  // the landing's notice opens, so it must carry the same token, or that panel offers only
  // real times. Both read the one grader with the deps' own minter: neither caller passes it.
  {
    const programCall = makeBooking({
      id: "bk-prog",
      salesforce_id: "sf1",
      manage_token: "tok-prog",
      assigned_user_id: "a",
      program_lead: true,
    });
    const r = await attempt({ personBookings: [programCall], agentNames: { a: "Aisha Bello" } });
    assert(
      r.declined?.disclose === true && r.declined.programLeadMoveToken === "move-token-for-bk-prog",
      `the confirm's existing call answer carries a program lead's move token (got ${r.declined?.disclose ? r.declined.programLeadMoveToken : "undisclosed"})`,
    );
    const landing = makeDeps({ personBookings: [programCall], agentNames: { a: "Aisha Bello" } });
    const landed = await findExistingCallForIdentity(personIdentityOf(bookerInput), landing.deps, { isTest: false });
    assert(
      JSON.stringify(landed) === JSON.stringify(r.declined),
      "the confirm path and the landing path hand the Move panel the same call",
    );
    const ordinary = await attempt({
      personBookings: [makeBooking({ id: "bk-plain", salesforce_id: "sf1", manage_token: "tok-plain", assigned_user_id: "a" })],
    });
    assert(
      ordinary.declined?.disclose === true && ordinary.declined.programLeadMoveToken === null,
      "control: an ordinary lead's existing call carries no move token",
    );
  }

  // --- Nobody else's booking blocks a lead ---
  {
    const r = await attempt({
      personBookings: [
        makeBooking({
          id: "bk-stranger",
          salesforce_id: "sf-other",
          attendee_email: "stranger@x.com",
          attendee_phone: "+19995550000",
        }),
      ],
    });
    assert(r.created, "a stranger's active booking does not decline this lead");
  }

  // --- The advisor is never guessed ---
  {
    const r = await attempt({
      personBookings: [
        makeBooking({ id: "bk-old", salesforce_id: "sf1", manage_token: "tok-old", assigned_user_id: "gone" }),
      ],
      agentNames: {},
    });
    assert(
      r.declined?.disclose === true && r.declined.advisorName === null,
      "an unresolvable advisor is null, never a placeholder or a borrowed name",
    );
  }

  {
    const r = await attempt({
      personBookings: [
        makeBooking({ id: "bk-old", salesforce_id: "sf1", manage_token: "tok-old" }),
      ],
      agentNameThrows: true,
    });
    assert(
      r.declined?.disclose === true && r.declined.advisorName === null,
      "a failed advisor lookup drops the name and still declines the booking",
    );
  }

  // --- The direct booking API is untouched ---
  {
    // bookViaApi's cross-bucket rebook (#364) deliberately creates while the old
    // booking still exists, then cancels it. It never opts in, so a match here
    // must NOT decline: this is the guard that keeps that path working.
    const r = await attempt(
      {
        personBookings: [
          makeBooking({ id: "bk-old", salesforce_id: "sf1", manage_token: "tok-old" }),
        ],
      },
      input,
    );
    assert(r.created, "without the opt-in, an existing call does not decline the create");
  }

  // --- A double-click still succeeds ---
  {
    // The lead's OWN just-created booking is a perfect self-match. The
    // idempotency fast path must return it before the refusal check runs, or a
    // re-submit reports "you already have a call booked" for their own booking.
    const own = makeBooking({
      id: "bk-mine",
      salesforce_id: "sf1",
      attendee_email: "k@x.com",
      attendee_phone: "+12035615295",
      manage_token: "tok-mine",
    });
    const { deps } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      existingByKey: own,
      personBookings: [own],
    });
    const res = await createBooking(bookerInput, deps);
    assert(
      res.booking.id === "bk-mine" && res.manageUrl.includes("tok-mine"),
      "a re-submit of the same booking returns it rather than declining it",
    );
  }

  // --- A failed lookup REFUSES rather than booking (#1641) -------------------
  // Read as a PAIR with the healthy control below it: a "no second booking was
  // created" assertion is satisfied by a fixture in which no booking could have
  // been created at all (L159), so the same fixture has to be shown creating one.
  {
    const own = makeBooking({
      id: "bk-old",
      salesforce_id: "sf1",
      attendee_email: "k@x.com",
      attendee_phone: "+12035615295",
      manage_token: "tok-old",
      assigned_user_id: "a",
    });

    // The read fails. Nothing may be written, and the lead must be told.
    const failed = await attemptUnavailable({ personBookings: [own], personBookingsThrows: true });
    assert(
      failed.unavailable,
      "a failed existing-call lookup refuses with ExistingCallCheckUnavailableError",
    );
    assert(
      failed.bookingsWritten === 0,
      `a failed existing-call lookup writes NO booking row (wrote ${failed.bookingsWritten})`,
    );
    assert(
      failed.events === 0,
      "a failed existing-call lookup creates no calendar invite either",
    );

    // Same fixture, read succeeding: the existing call IS found and deduped, so
    // the assertions above are about the refusal and not about a dead fixture.
    const healthy = await attempt({ personBookings: [own], agentNames: { a: "Aisha Bello" } });
    assert(
      !healthy.created && healthy.declined !== null,
      "healthy control: the same fixture finds the existing call and declines",
    );
    assert(
      healthy.bookingsWritten === 0,
      "healthy control: a declined second booking writes no booking row",
    );

    // Same fixture again with NOBODY on record: it really does create, so
    // "wrote 0 rows" above is a suppressed write rather than a fixture that
    // never writes.
    const fresh = await attempt({ personBookings: [] });
    assert(
      fresh.created && fresh.bookingsWritten === 1,
      `control: with no existing call the same fixture writes one booking (wrote ${fresh.bookingsWritten})`,
    );
  }

  finish();
}

void run();

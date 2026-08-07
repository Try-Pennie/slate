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
 *  - **It fails OPEN, loudly.** A lookup error books the call and logs; refusing
 *    on a database hiccup would cost the lead their call entirely.
 *
 * Run: node --experimental-strip-types scripts/test-booking-existing-call.ts
 */
import {
  createBooking,
  ExistingCallError,
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
): Promise<{ declined: ExistingCall | null; created: boolean; events: number }> {
  const { deps, calls } = makeDeps({
    candidates: ["a"],
    freeEmails: new Set(["a@x.com"]),
    ...over,
  });
  try {
    await createBooking(inp, deps);
    return { declined: null, created: true, events: calls.createEvent.length };
  } catch (err) {
    if (err instanceof ExistingCallError) {
      // A calendar invite is the observable proof a booking happened, so its
      // absence is what "nothing was created" actually means to a lead.
      return { declined: err.existingCall, created: false, events: calls.createEvent.length };
    }
    throw err;
  }
}

async function run() {
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

  // --- Fails open, loudly ---
  {
    const r = await attempt({
      personBookingsThrows: true,
    });
    assert(
      r.created,
      "a failed existing-call lookup books the call rather than refusing it",
    );
  }

  finish();
}

void run();

// #2412: what the booker DOES with the verdict the per agent fallback reports.
//
// The service half of this lives in
// `src/lib/booking/verify-on-book-unreadable-calendar.test.ts`, which drives the
// real Google reply through the real parser and proves that a calendar carrying
// `errors[]` inside a 200 comes back `unverified` rather than free. This half
// takes that verdict and asks the question a lead cares about: is the booking
// refused, or is an invite created over a calendar nobody could read?
//
// The split is the harness boundary (AGENTS.md, "Where a new test goes"): the
// service half needs `vi.mock` for Supabase and the delegated token, and the
// shared booking fake lives in `scripts/`, which the app's `tsc` program
// deliberately does not include.
import { createBooking, VerifyUnavailableError } from "../src/lib/booking/orchestration.ts";
import { makeDeps, bucket, input } from "./lib/booking-fakes.ts";
import { assert, finish } from "./lib/harness.ts";

/** Asserts on a value and reports what it actually was when it differs. */
function eq<T>(got: T, want: T, msg: string) {
  assert(got === want, `${msg}${got === want ? "" : ` (got ${JSON.stringify(got)})`}`);
}

// The shared fake's candidate "a" resolves to this address.
const AGENT = "a@x.com";

/**
 * One candidate, and verify on book could not read their calendar. This is
 * exactly the set `verifyAgentsDirectly` answers with when Google reports a per
 * calendar error inside its 200: nobody free, that agent unverified.
 */
function depsWithUnverifiedAgent() {
  return makeDeps({
    candidates: ["a"],
    freeEmails: new Set<string>(),
    unverifiedEmails: new Set([AGENT]),
  });
}

async function run() {
  // 1. The headline: nothing reaches the agent's calendar and nothing reaches
  // the bookings table. Both are asserted, and asserted BEFORE the throw, because
  // "it threw" is not the claim being made (L475).
  {
    const fake = depsWithUnverifiedAgent();
    let threw: unknown = null;
    try {
      await createBooking({ ...input, bucketCode: bucket.code }, fake.deps);
    } catch (err) {
      threw = err;
    }
    eq(fake.calls.createEvent.length, 0, "no calendar invite is created for an unverified agent");
    eq(fake.calls.insertBooking.length, 0, "no booking row is written for an unverified agent");
    assert(
      threw instanceof VerifyUnavailableError,
      "an unverified candidate refuses with VerifyUnavailableError",
    );
  }

  // 2. The lead is told the time could not be CONFIRMED, and to try again. It
  // must not read as "no times are available": that sends them to pick another
  // slot for a reason that is not true, and a refusal nobody can act on is its
  // own defect.
  {
    const fake = depsWithUnverifiedAgent();
    let message = "";
    try {
      await createBooking({ ...input, bucketCode: bucket.code }, fake.deps);
    } catch (err) {
      message = (err as Error).message;
    }
    eq(
      message,
      "We hit a temporary issue confirming this time. Please try again in a moment.",
      "the lead is told this is temporary and to retry, not that the slot is taken",
    );
  }

  // 3. The control that stops this reading as "the path is simply broken": the
  // same wiring with a verifiable, free agent books normally.
  {
    const fake = makeDeps({ candidates: ["a"], freeEmails: new Set([AGENT]) });
    await createBooking({ ...input, bucketCode: bucket.code }, fake.deps);
    eq(fake.calls.createEvent.length, 1, "a verified free agent is still booked");
    eq(fake.calls.createEvent[0].email, AGENT, "the invite goes to that agent");
  }

  // 4. The other direction: a candidate who is genuinely BUSY is a full slot, not
  // an outage, and must keep its own message. One answering for the other is how
  // somebody chases a Google incident that never happened (L11).
  {
    const fake = makeDeps({ candidates: ["a"], freeEmails: new Set<string>() });
    let name = "";
    try {
      await createBooking({ ...input, bucketCode: bucket.code }, fake.deps);
    } catch (err) {
      name = (err as Error).name;
    }
    assert(
      name !== "VerifyUnavailableError",
      "a genuinely busy pool is not reported as a verify outage",
    );
    eq(fake.calls.createEvent.length, 0, "a busy pool creates no invite either");
  }

  finish();
}

void run();

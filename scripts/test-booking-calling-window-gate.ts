// #2310: the server enforces the lead's calling window at every place a call's
// TIME is chosen or moved: a fresh booking, a lead or admin reschedule, and the
// direct API's own reschedule arm. The booker filters the offered list too, but a
// client filter is a convenience; the refusal here is the rule.
//
// Each refusal must happen BEFORE anything is written: no calendar event, no
// reservation, no lease, no contact correction. A refused move that had already
// rewritten the lead's details would be a half done change nobody asked for.
//
// Run: node --experimental-strip-types scripts/test-booking-calling-window-gate.ts
import {
  createBooking,
  rescheduleBooking,
  bookViaApi,
  OutsideCallingWindowError,
} from "../src/lib/booking/orchestration.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  input,
  bucket,
  eventType,
  RR,
  NOW,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

// 2026-06-08 is in EDT (UTC-4) and Honolulu is UTC-10.
const HNL_0759 = "2026-06-08T17:59:00.000Z";
const HNL_0800 = "2026-06-08T18:00:00.000Z";
const NY_0759 = "2026-06-08T11:59:00.000Z";
const NY_2000 = "2026-06-09T00:00:00.000Z";

async function refused(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

async function run() {
  // --- create: a start before 08:00 in the lead's zone is refused, nothing written ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const err = await refused(() =>
      createBooking({ ...input, startIso: HNL_0759, timezone: "Pacific/Honolulu" }, deps),
    );
    assert(err instanceof OutsideCallingWindowError, "create: 07:59 Honolulu is refused with its own error");
    assert(
      calls.createEvent.length === 0 && calls.reservations.length === 0 && calls.moveBusyBlock.length === 0,
      "create: a refused start writes no event, reservation or busy block",
    );
  }

  // --- create: 08:00 in the lead's zone goes through ---
  {
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const res = await createBooking({ ...input, startIso: HNL_0800, timezone: "Pacific/Honolulu" }, deps);
    assert(res.booking.id === "bk-new", "create: 08:00 Honolulu is booked");
  }

  // --- create: 20:00 is the first minute outside ---
  {
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const err = await refused(() =>
      createBooking({ ...input, startIso: NY_2000, timezone: "America/New_York" }, deps),
    );
    assert(err instanceof OutsideCallingWindowError, "create: 20:00 New York is refused");
  }

  // --- create: an unreadable zone is judged in the fallback, never waved through ---
  {
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const err = await refused(() => createBooking({ ...input, startIso: NY_0759, timezone: "Not/AZone" }, deps));
    assert(err instanceof OutsideCallingWindowError, "create: a garbage zone is judged in Eastern and 07:59 refused");
  }

  // --- the refusal names the zone it judged in, for the log and the API body ---
  {
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const err = await refused(() =>
      createBooking({ ...input, startIso: HNL_0759, timezone: "Pacific/Honolulu" }, deps),
    );
    assert(
      err instanceof OutsideCallingWindowError && err.zone === "Pacific/Honolulu",
      "the refusal carries the zone it was judged in",
    );
  }

  // --- reschedule with the lead's zone: refused before the contact write or the lease ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const err = await refused(() =>
      rescheduleBooking("tok1", HNL_0759, RR, "customer", deps, NOW, undefined, { phone: "+12035550100" }, {
        leadZone: "Pacific/Honolulu",
      }),
    );
    assert(err instanceof OutsideCallingWindowError, "reschedule: 07:59 in the lead's zone is refused");
    assert(calls.claimReschedule === 0, "reschedule: refused before the lease is claimed");
    assert(calls.updateEventTime.length === 0, "reschedule: the event is not moved");
    assert(calls.updateBookingContact.length === 0, "reschedule: the typed details are not written on a refused move");
  }

  // --- reschedule with the lead's zone: 08:00 goes through ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const res = await rescheduleBooking("tok1", HNL_0800, RR, "customer", deps, NOW, undefined, undefined, {
      leadZone: "Pacific/Honolulu",
    });
    assert(res.booking.starts_at === HNL_0800, "reschedule: 08:00 in the lead's zone moves");
  }

  // --- admin reschedule (no zone given): judged in the zone the lead BOOKED in ---
  {
    const ctx = { booking: makeBooking({ timezone: "Pacific/Honolulu" }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    // 10:00 Eastern is 04:00 in Honolulu: fine for the admin's clock, not the lead's.
    const err = await refused(() =>
      rescheduleBooking("tok1", "2026-06-08T14:00:00.000Z", RR, "admin", deps, NOW),
    );
    assert(err instanceof OutsideCallingWindowError, "admin reschedule: judged in the booking's own zone");
    assert(calls.claimReschedule === 0, "admin reschedule: refused before the lease");
  }

  // --- admin IN-PLACE reschedule (the same agent is free, so the event would be
  //     moved in place): 07:30 in the booking's zone is refused, nothing written.
  //     The positive control first: the same fixture at 10:00 really does take
  //     the in-place branch, so the refusal below is not a reassign path's. ---
  {
    const ctx = { booking: makeBooking({ timezone: "America/New_York" }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "admin", deps, NOW);
    assert(
      calls.updateEventTime.length === 1 && calls.createEvent.length === 0,
      "control: an admin move to 10:00 New York takes the in-place branch",
    );
  }
  {
    const ctx = { booking: makeBooking({ timezone: "America/New_York" }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    // 2026-06-09T11:30Z is 07:30 EDT.
    const err = await refused(() =>
      rescheduleBooking("tok1", "2026-06-09T11:30:00.000Z", RR, "admin", deps, NOW),
    );
    assert(err instanceof OutsideCallingWindowError, "admin in-place reschedule to 07:30 is refused");
    assert(
      calls.claimReschedule === 0 &&
        calls.updateEventTime.length === 0 &&
        calls.createEvent.length === 0 &&
        calls.moveBusyBlock.length === 0 &&
        calls.bookingEvents.length === 0 &&
        calls.webhooks.length === 0,
      "admin in-place reschedule to 07:30: no lease, event move, busy block, history row or webhook",
    );
  }

  // --- distinct causes keep their own refusal (L11): the calling-window
  //     pre-check must not answer for a booking that does not exist, or one
  //     that can no longer be changed. Both reach the pre-check here, because
  //     the zone is supplied and 07:59 Honolulu is outside the window. ---
  {
    const { deps, calls } = makeDeps({ freeEmails: new Set(["a@x.com"]) });
    const err = await refused(() =>
      rescheduleBooking("nope", HNL_0759, RR, "customer", deps, NOW, undefined, undefined, {
        leadZone: "Pacific/Honolulu",
      }),
    );
    assert(
      err instanceof Error && !(err instanceof OutsideCallingWindowError) && err.message === "Booking not found",
      "an unknown token is refused as not found, not as outside calling hours",
    );
    assert(calls.claimReschedule === 0, "an unknown token claims nothing");
  }
  for (const status of ["cancelled", "completed"] as const) {
    const ctx = { booking: makeBooking({ status }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const err = await refused(() =>
      rescheduleBooking("tok1", HNL_0759, RR, "customer", deps, NOW, undefined, { phone: "+12035550100" }, {
        leadZone: "Pacific/Honolulu",
      }),
    );
    assert(
      err instanceof Error &&
        !(err instanceof OutsideCallingWindowError) &&
        err.message === "This booking can no longer be changed",
      `a ${status} booking is refused as unchangeable, not as outside calling hours`,
    );
    assert(
      calls.claimReschedule === 0 && calls.updateBookingContact.length === 0,
      `a ${status} booking: no lease and no contact write`,
    );
  }

  // --- a page cached from before #2310 sends the lead's typed details but NO
  //     zone. The booking's own zone judges it, and the refusal must land before
  //     the contact write, or the details are saved behind a move that failed. ---
  {
    const ctx = { booking: makeBooking({ timezone: "Pacific/Honolulu" }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const err = await refused(() =>
      rescheduleBooking("tok1", HNL_0759, RR, "customer", deps, NOW, undefined, { phone: "+12035550100" }),
    );
    assert(err instanceof OutsideCallingWindowError, "no zone plus a contact correction: refused in the booking's zone");
    assert(
      calls.updateBookingContact.length === 0 && calls.claimReschedule === 0,
      "no zone plus a contact correction: the details are not saved and nothing is claimed",
    );
  }

  // --- a no-op reschedule onto the time it already has is not re-judged ---
  {
    // A call booked before the gate existed can sit outside the window; a
    // double click that lands on the same instant moves nothing and must not
    // turn into a refusal about a time the lead already holds.
    const ctx = {
      booking: makeBooking({ starts_at: HNL_0759, timezone: "Pacific/Honolulu" }),
      bucket,
      eventType,
    };
    const { deps } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const res = await rescheduleBooking("tok1", HNL_0759, RR, "customer", deps, NOW);
    assert(res.booking.starts_at === HNL_0759, "a same instant reschedule is a no-op, not a refusal");
  }

  // --- the direct API's reschedule arm is judged in the zone the caller sent ---
  {
    const existing = makeBooking({ salesforce_id: "sf1", external_id: "ext1" });
    const ctx = { booking: existing, bucket, eventType };
    const { deps, calls } = makeDeps({
      existing: ctx,
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      personBookings: [existing],
    });
    const err = await refused(() =>
      bookViaApi(
        { ...input, externalId: "ext1", startIso: HNL_0759, timezone: "Pacific/Honolulu" },
        deps,
      ),
    );
    assert(err instanceof OutsideCallingWindowError, "API: a move to 07:59 in the caller's zone is refused");
    assert(calls.claimReschedule === 0 && calls.createEvent.length === 0, "API: nothing is written");
  }
}

run().then(finish, (err) => {
  console.error(err);
  process.exit(1);
});

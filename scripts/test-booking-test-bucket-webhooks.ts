// #459: bookings on an is_test bucket must never emit downstream webhooks.
//
// The smoke test books real bookings through the key-authed API (allowTestBuckets),
// so without a gate every smoke run injects a synthetic lead into Regal/Cadence and
// then cancels it. The gate lives in orchestration's `fire()`, the single choke point
// every booking webhook passes through, so create/cancel/reschedule/complete are all
// covered by one check.
//
// Suppression must be surgical: the booking itself, the calendar event, the busy
// blocks and the history rows all still have to work, or the smoke test stops
// testing anything.
// Run: node --experimental-strip-types scripts/test-booking-test-bucket-webhooks.ts
import {
  createBooking,
  cancelBooking,
  rescheduleBooking,
  reassignBooking,
  completePastBookings,
} from "../src/lib/booking/orchestration.ts";
import type { Bucket, User } from "../src/lib/db/types.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
  input,
  NOW,
  RR,
  CR,
  SYS,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/** A hidden smoke-test bucket (#396, migration 0051). */
const testBucket = { ...bucket, id: "bkt-test", code: "999", is_test: true } as Bucket;
/** A real, lead-facing bucket. Distinct code so a mixed batch is attributable. */
const realBucket = { ...bucket, id: "bkt-real", code: "412" } as Bucket;

async function run() {
  // --- create: the smoke test's booking reaches no downstream system ---
  {
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      testBucket: true,
    });
    const res = await createBooking({ ...input, allowTestBuckets: true }, deps);
    assert(
      calls.webhooks.length === 0,
      "create(test bucket): emits no booking.created (no synthetic lead in Regal/Cadence)",
    );
    // Surgical: the smoke test still has to actually book something.
    assert(res.booking.id === "bk-new", "create(test bucket): the booking is still made");
    assert(calls.createEvent.length === 1, "create(test bucket): the calendar event is still created");
  }

  // --- create control: a real bucket still emits ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    await createBooking(input, deps);
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.created",
      "create(real bucket): still fires booking.created",
    );
  }

  // --- cancel: the smoke test's teardown reaches no downstream system ---
  {
    const ctx = { booking: makeBooking({}), bucket: testBucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    await cancelBooking("tok1", CR, "customer", deps);
    assert(
      calls.webhooks.length === 0,
      "cancel(test bucket): emits no booking.cancelled (no phantom cancellation downstream)",
    );
    // Surgical: the teardown still has to clean up, or smoke runs leak calendar events.
    assert(calls.deleteEvent.length === 1, "cancel(test bucket): still deletes the calendar event");
    assert(calls.deleteBusyBlocks.length === 1, "cancel(test bucket): still removes the busy block");
    assert(
      calls.bookingEvents.length === 1 && calls.bookingEvents[0].action === "cancelled",
      "cancel(test bucket): still records the history row",
    );
  }

  // --- cancel control: a real bucket still emits ---
  {
    const ctx = { booking: makeBooking({}), bucket: realBucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    await cancelBooking("tok1", CR, "customer", deps);
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.cancelled",
      "cancel(real bucket): still fires booking.cancelled",
    );
  }

  // --- reschedule: the smoke test's move reaches no downstream system ---
  {
    const ctx = { booking: makeBooking({}), bucket: testBucket, eventType };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-09T14:00:00.000Z",
        ends_at: "2026-06-09T14:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket: testBucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      freeEmails: new Set(["a@x.com"]),
    });
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      calls.webhooks.length === 0,
      "reschedule(test bucket): emits no booking.rescheduled",
    );
    // Surgical: the move itself still commits.
    assert(
      calls.updateEventTime.length === 1,
      "reschedule(test bucket): still moves the calendar event",
    );
  }

  // --- reschedule control: a real bucket still emits ---
  {
    const ctx = { booking: makeBooking({}), bucket: realBucket, eventType };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-09T14:00:00.000Z",
        ends_at: "2026-06-09T14:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket: realBucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      freeEmails: new Set(["a@x.com"]),
    });
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.rescheduled",
      "reschedule(real bucket): still fires booking.rescheduled",
    );
  }

  // --- reassign: the smoke test's reassign scenario (#450) stays internal too ---
  // Reassign deliberately emits booking.rescheduled (the Regal contract), so it is a
  // fifth way a smoke booking could reach downstream.
  {
    const ctx = { booking: makeBooking({}), bucket: testBucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      calls.webhooks.length === 0,
      "reassign(test bucket): emits no booking.rescheduled",
    );
    assert(calls.createEvent.length === 1, "reassign(test bucket): the swap still happens");
  }

  // --- reassign control: a real bucket still emits ---
  {
    const ctx = { booking: makeBooking({}), bucket: realBucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.rescheduled",
      "reassign(real bucket): still fires booking.rescheduled",
    );
  }

  // --- completion sweep: a mixed batch suppresses per booking, not all-or-nothing ---
  // The cron completes every past booking in one sweep, so a smoke booking and a real
  // lead's booking routinely land in the same batch. A gate that keyed off the batch
  // rather than the row would either leak the smoke event or swallow the real one.
  {
    const pastDue = [
      { booking: makeBooking({ id: "p-test", status: "confirmed" }), bucket: testBucket, eventType },
      { booking: makeBooking({ id: "p-real", status: "confirmed" }), bucket: realBucket, eventType },
    ];
    const { deps, calls } = makeDeps({ pastDue });
    const completed = await completePastBookings(deps);
    assert(completed === 2, "complete(mixed batch): both bookings still transition to completed");
    assert(
      calls.webhooks.length === 1,
      "complete(mixed batch): exactly one booking.completed fires (the test bucket's is suppressed)",
    );
    assert(
      calls.webhooks[0].event === "booking.completed" && calls.webhooks[0].bucket_code === "412",
      "complete(mixed batch): the surviving webhook is the real bucket's, not the test bucket's",
    );
  }

  finish();
}

run();

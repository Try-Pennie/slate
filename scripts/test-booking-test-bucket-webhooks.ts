// #459: bookings on an is_test bucket must never reach Regal/Cadence.
//
// The smoke test books real bookings through the key-authed API (allowTestBuckets),
// so without a gate every smoke run injects a synthetic lead downstream and then
// cancels it. The gate lives in orchestration's `fire()`, the single choke point
// every booking webhook passes through, so create/cancel/reschedule/complete are all
// covered by one check.
//
// The emission is still RECORDED, marked suppressed, and only the external POST is
// skipped (mirroring the existing loadtest short-circuit). Dropping the emission
// entirely would erase the webhook_deliveries rows that scripts/smoke-create-resume.ts
// counts to prove the exactly-once dedupe on the crash-resume path. emit.test.ts owns
// the "a suppressed row is never POSTed, by any send path" half of the guarantee.
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
      calls.webhooks.length === 1 && calls.webhooks[0].suppressed === true,
      "create(test bucket): records booking.created as suppressed (no synthetic lead in Regal/Cadence)",
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
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.created" &&
        calls.webhooks[0].suppressed === false,
      "create(real bucket): fires booking.created unsuppressed",
    );
  }

  // --- cancel: the smoke test's teardown reaches no downstream system ---
  {
    const ctx = { booking: makeBooking({}), bucket: testBucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    await cancelBooking("tok1", CR, "customer", deps);
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].suppressed === true,
      "cancel(test bucket): records booking.cancelled as suppressed (no phantom cancellation downstream)",
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
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.cancelled" &&
        calls.webhooks[0].suppressed === false,
      "cancel(real bucket): fires booking.cancelled unsuppressed",
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
      calls.webhooks.length === 1 && calls.webhooks[0].suppressed === true,
      "reschedule(test bucket): records booking.rescheduled as suppressed",
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
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.rescheduled" &&
        calls.webhooks[0].suppressed === false,
      "reschedule(real bucket): fires booking.rescheduled unsuppressed",
    );
  }

  // --- reassign: the smoke test's reassign scenario (#450) stays internal too ---
  // A reassign emits booking.reassigned (#2368; it was booking.rescheduled until
  // then, which told Regal a time change had happened when none had), so it is a
  // fifth way a smoke booking could reach downstream, and the gate has to cover the
  // new event as surely as it covered the old one.
  {
    const ctx = { booking: makeBooking({}), bucket: testBucket, eventType };
    // A TEST agent, as the canary's reassign target really is: a test booking
    // never moves onto a real agent (#2660), so the fixture says which world the
    // target is in rather than leaving the flag off.
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true, is_test: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.reassigned" &&
        calls.webhooks[0].suppressed === true,
      "reassign(test bucket): records booking.reassigned as suppressed",
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
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.reassigned" &&
        calls.webhooks[0].suppressed === false,
      "reassign(real bucket): fires booking.reassigned unsuppressed",
    );
    // #2368: and it is the ONLY event. A reassign that also emitted a reschedule
    // would reach Regal twice, once about a time change that never happened.
    assert(
      !calls.webhooks.some((w) => w.event === "booking.rescheduled"),
      "reassign(real bucket): fires no booking.rescheduled alongside it",
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
    const { completed } = await completePastBookings(deps);
    assert(completed === 2, "complete(mixed batch): both bookings still transition to completed");
    assert(
      calls.webhooks.length === 2,
      "complete(mixed batch): both bookings record a booking.completed emission",
    );
    const testEmit = calls.webhooks.find((w) => w.bucket_code === "999");
    const realEmit = calls.webhooks.find((w) => w.bucket_code === "412");
    assert(
      testEmit?.suppressed === true,
      "complete(mixed batch): the test bucket's emission is suppressed",
    );
    assert(
      realEmit?.suppressed === false,
      "complete(mixed batch): the real lead's emission is NOT suppressed (the gate is per row, not per batch)",
    );
  }

  finish();
}

run();

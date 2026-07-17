// cancelBooking idempotency + terminal states, and completePastBookings.
//
// Split out of the old 3,229-line scripts/test-booking-orchestration.ts (#605);
// the shared BookingDeps fake lives in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-booking-cancel-complete.ts
import {
  cancelBooking,
  completePastBookings,
  BookingNotCancellableError,
} from "../src/lib/booking/orchestration.ts";
import {
  PAST_COMPLETION_BATCH_LIMIT,
  MAX_COMPLETION_DRAIN_BATCHES,
} from "../src/lib/booking/core.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
  NOW,
  CR,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function run() {
  // --- cancel: happy + idempotent ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    await cancelBooking("tok1", CR, "customer", deps, NOW);
    assert(calls.deleteEvent.length === 1, "cancel: deletes the calendar event");
    assert(calls.deleteBusyBlocks.length === 1, "cancel: removes the busy block");
    assert(
      calls.claimCancellation.length === 1 && calls.claimCancellation[0] === ctx.booking.id,
      "cancel: marks the booking cancelled (via the atomic claim)",
    );
    assert(calls.webhooks[0].event === "booking.cancelled", "cancel: fires booking.cancelled");
    assert(
      calls.webhooks[0].dedupeKey === "evt-1" && calls.bookingEvents.length === 1,
      "cancel: webhook dedupe key is the booking_events row id (#436)",
    );
    // #326: records a 'cancelled' history event (no to-time) + reason on webhook.
    assert(
      calls.bookingEvents.length === 1 &&
        calls.bookingEvents[0].action === "cancelled" &&
        calls.bookingEvents[0].initiator === "customer" &&
        calls.bookingEvents[0].reason_code === "no_longer_interested" &&
        calls.bookingEvents[0].to_starts_at === null,
      "cancel: records one 'cancelled' history event with the reason and no to-time",
    );
    assert(
      JSON.stringify(calls.webhooks[0].reason) ===
        JSON.stringify({ code: "no_longer_interested", detail: null, initiator: "customer" }),
      "cancel: webhook payload carries the reason + initiator",
    );

    const ctx2 = { booking: makeBooking({ status: "cancelled" }), bucket, eventType };
    const { deps: d2, calls: c2 } = makeDeps({ existing: ctx2 });
    await cancelBooking("tok1", CR, "customer", d2);
    assert(
      c2.deleteEvent.length === 0 && c2.commitReschedule.length === 0 && c2.webhooks.length === 0,
      "cancel: no-op when already cancelled (no re-delete / re-webhook)",
    );
    // But the mandatory reason is still captured once for the already-cancelled
    // re-submit (covers a first attempt that flipped status but lost the reason).
    assert(
      c2.bookingEvents.length === 1 && c2.bookingEvents[0].action === "cancelled",
      "cancel re-submit: records the reason once for an already-cancelled booking",
    );
  }

  // --- #884: a user-facing cancel defers the booking.cancelled send ---
  // The cancel runs the outbox NOTIFY step inline on the request; with a scheduler
  // on its deps, that emission is handed off so the cancel response isn't blocked
  // on the Regal/Cadence round-trip. The outbox drain (no scheduler) sends inline.
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, deferSend: () => {} });
    await cancelBooking("tok1", CR, "customer", deps, NOW);
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.cancelled" &&
        calls.webhooks[0].deferred === true,
      "#884: cancel defers the booking.cancelled send off the response path",
    );
  }

  // --- cancel: completed booking cannot be flipped to cancelled (#618) ---
  {
    // Customer clicks the cancel link AFTER the meeting completed. The status
    // regression completed->cancelled must be rejected with a friendly 4xx and
    // touch NOTHING (no claim, no gcal delete, no contradictory webhook).
    const ctx = { booking: makeBooking({ status: "completed" }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    let err: unknown;
    try {
      await cancelBooking("tok1", CR, "customer", deps, NOW);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof BookingNotCancellableError,
      "cancel completed: rejects a customer cancel of a completed booking",
    );
    assert(
      calls.claimCancellation.length === 0 &&
        calls.deleteEvent.length === 0 &&
        calls.webhooks.length === 0 &&
        calls.bookingEvents.length === 0,
      "cancel completed: writes nothing (no claim, no gcal delete, no webhook, no event)",
    );

    // The DB net (#618): a non-customer initiator (admin/rebook/system) does NOT
    // throw, but the status-gated claim no-ops on a completed row, so the cancel
    // is a silent no-op with no side effects instead of a status regression.
    const ctx2 = { booking: makeBooking({ status: "completed" }), bucket, eventType };
    const { deps: d2, calls: c2 } = makeDeps({ existing: ctx2 });
    let threw2 = false;
    let result2: boolean | undefined;
    try {
      result2 = await cancelBooking("tok1", CR, "admin", d2, NOW);
    } catch {
      threw2 = true;
    }
    assert(!threw2, "cancel completed: an admin/system cancel does not throw");
    assert(
      result2 === false &&
        c2.deleteEvent.length === 0 &&
        c2.webhooks.length === 0,
      "cancel completed: the DB net makes an admin cancel of a completed booking a no-op",
    );
  }

  // --- cancel: concurrent double-cancel resolves to one terminal state (#618) ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    const first = await cancelBooking("tok1", CR, "customer", deps, NOW);
    // Second cancel races: it passes the pre-check (the fake ctx still reads
    // active) but LOSES the atomic claim, so it must fire no second side effect.
    const second = await cancelBooking("tok1", CR, "customer", deps, NOW);
    assert(first === true && second === false, "double-cancel: exactly one call wins the claim");
    assert(
      calls.deleteEvent.length === 1 && calls.webhooks.length === 1,
      "double-cancel: side effects fire exactly once (one terminal state)",
    );
  }

  // --- completePastBookings ---
  {
    const due = [
      { booking: makeBooking({ id: "p1", status: "confirmed" }), bucket, eventType },
      { booking: makeBooking({ id: "p2", status: "rescheduled" }), bucket, eventType },
    ];
    const { deps, calls } = makeDeps({ pastDue: due });
    const n = await completePastBookings(deps);
    assert(n === 2, "complete: returns the count of completed bookings");
    assert(
      calls.completeBookingsIfDue.length === 1 &&
        calls.completeBookingsIfDue[0].length === 2 &&
        calls.completeBookingsIfDue[0].includes("p1") &&
        calls.completeBookingsIfDue[0].includes("p2"),
      "complete: transitions all due bookings in a single batched call (#164)",
    );
    assert(
      calls.webhooks.length === 2 && calls.webhooks.every((w) => w.event === "booking.completed"),
      "complete: fires booking.completed for each",
    );
    assert(
      calls.webhooks.every((w) => w.deferred === false),
      "#884: the completion sweep sends inline (no scheduler), so its bounded fan-out still caps connections",
    );

    const { deps: dEmpty } = makeDeps({ pastDue: [] });
    assert((await completePastBookings(dEmpty)) === 0, "complete: zero when nothing is due");

    // #163: an overlapping cron tick already flipped p1 to completed, so the
    // conditional transition no-ops there and booking.completed must NOT re-fire.
    const { deps: dRace, calls: cRace } = makeDeps({
      pastDue: due,
      alreadyCompleted: new Set(["p1"]),
    });
    const raced = await completePastBookings(dRace);
    assert(raced === 1, "complete: counts only rows this tick actually transitioned");
    assert(
      cRace.webhooks.length === 1 && cRace.webhooks[0].event === "booking.completed",
      "complete: no duplicate booking.completed for an already-completed row",
    );
  }

  // --- completePastBookings drains the whole backlog (#871) ---
  {
    const fullBatch = (tag: string) =>
      Array.from({ length: PAST_COMPLETION_BATCH_LIMIT }, (_, i) => ({
        booking: makeBooking({ id: `${tag}-${i}`, status: "confirmed" }),
        bucket,
        eventType,
      }));

    // A backlog spanning three loads (200 + 200 + 30) drains in a single run:
    // two full batches keep the loop going, the under-cap third ends it.
    const tail = Array.from({ length: 30 }, (_, i) => ({
      booking: makeBooking({ id: `tail-${i}`, status: "rescheduled" }),
      bucket,
      eventType,
    }));
    const { deps, calls } = makeDeps({
      pastDueBatches: [fullBatch("a"), fullBatch("b"), tail],
    });
    const drained = await completePastBookings(deps);
    assert(
      drained === PAST_COMPLETION_BATCH_LIMIT * 2 + 30,
      "drain: completes every booking across the batches in one run",
    );
    assert(
      calls.completeBookingsIfDue.length === 3,
      "drain: one batched transition per loaded batch",
    );
    assert(
      calls.webhooks.length === PAST_COMPLETION_BATCH_LIMIT * 2 + 30 &&
        calls.webhooks.every((w) => w.event === "booking.completed"),
      "drain: fires booking.completed for every drained booking",
    );
    // The loop stopped after the under-cap batch: no needless extra fetch.
    assert(
      calls.loadPastBookingsToComplete === 3,
      "drain: stops loading once a batch comes back under the cap",
    );

    // Stall guard: a FULL batch that transitions zero rows (only unresolvable
    // rows left, already error-logged per row) must stop the loop, not re-fetch
    // the same set forever.
    const stallBatch = fullBatch("stall");
    const { deps: dStall, calls: cStall } = makeDeps({
      pastDueBatches: [stallBatch, fullBatch("never")],
      alreadyCompleted: new Set(stallBatch.map((b) => b.booking.id)),
    });
    const stalled = await completePastBookings(dStall);
    assert(stalled === 0, "drain: zero-progress full batch completes nothing");
    assert(
      cStall.completeBookingsIfDue.length === 1 &&
        cStall.loadPastBookingsToComplete === 1,
      "drain: a zero-progress batch stops the loop instead of re-fetching",
    );

    // Budget guard: more full batches than the per-run cap allows. The run
    // drains exactly the cap's worth and warns that a backlog still waits.
    const overflow = Array.from(
      { length: MAX_COMPLETION_DRAIN_BATCHES + 3 },
      (_, i) => fullBatch(`of-${i}`),
    );
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (line?: unknown) => {
      warns.push(String(line));
    };
    let over = 0;
    try {
      const { deps: dOver, calls: cOver } = makeDeps({ pastDueBatches: overflow });
      over = await completePastBookings(dOver);
      assert(
        cOver.completeBookingsIfDue.length === MAX_COMPLETION_DRAIN_BATCHES,
        "drain: stops at the per-run batch cap",
      );
    } finally {
      console.warn = origWarn;
    }
    assert(
      over === PAST_COMPLETION_BATCH_LIMIT * MAX_COMPLETION_DRAIN_BATCHES,
      "drain: completes exactly the cap's worth when the backlog overflows",
    );
    assert(
      warns.some(
        (w) =>
          w.includes("tag=completion-sweep") &&
          w.includes("drain budget exhausted"),
      ),
      "drain: warns loudly when the backlog outgrows one run's budget",
    );
  }

}

await run();
finish();

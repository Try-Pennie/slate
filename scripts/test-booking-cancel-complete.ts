// cancelBooking idempotency + terminal states, and completePastBookings.
//
// Split out of the old 3,229-line scripts/test-booking-orchestration.ts (#605);
// the shared BookingDeps fake lives in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-booking-cancel-complete.ts
import {
  cancelBooking,
  cancelBookingWithDetail,
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
    const { completed: n, backlogRemains: nBacklog } = await completePastBookings(deps);
    assert(n === 2, "complete: returns the count of completed bookings");
    assert(nBacklog === false, "complete: an under-cap batch reports no backlog remaining");
    assert(
      calls.completeBookingsIfDue.length === 1 &&
        calls.completeBookingsIfDue[0].length === 2 &&
        calls.completeBookingsIfDue[0].includes("p1") &&
        calls.completeBookingsIfDue[0].includes("p2"),
      "complete: transitions all due bookings in a single batched call (#164)",
    );
    // #2915: completion is on the clock (the call's end time passed), not evidence the
    // call happened, so it fired for no-shows too. Regal knows from its own call data;
    // the sweep only marks the row now and tells nobody.
    assert(calls.webhooks.length === 0, "#2915 complete: sends no webhook for a completed booking");

    const { deps: dEmpty } = makeDeps({ pastDue: [] });
    assert(
      (await completePastBookings(dEmpty)).completed === 0,
      "complete: zero when nothing is due",
    );

    // #163: an overlapping cron tick already flipped p1 to completed, so the
    // conditional transition no-ops there and only p1's own tick counts it.
    const { deps: dRace } = makeDeps({
      pastDue: due,
      alreadyCompleted: new Set(["p1"]),
    });
    const raced = (await completePastBookings(dRace)).completed;
    assert(raced === 1, "complete: counts only rows this tick actually transitioned");
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
    const { completed: drained, backlogRemains: drainedBacklog } =
      await completePastBookings(deps);
    assert(
      drained === PAST_COMPLETION_BATCH_LIMIT * 2 + 30,
      "drain: completes every booking across the batches in one run",
    );
    assert(
      drainedBacklog === false,
      "drain: a run that clears the whole backlog reports none remaining",
    );
    assert(
      calls.completeBookingsIfDue.length === 3,
      "drain: one batched transition per loaded batch",
    );
    assert(calls.webhooks.length === 0, "#2915 drain: sends no webhook for any drained booking");
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
    const { completed: stalled, backlogRemains: stalledBacklog } =
      await completePastBookings(dStall);
    assert(stalled === 0, "drain: zero-progress full batch completes nothing");
    assert(
      stalledBacklog === false,
      "drain: a zero-progress stop is not an over-budget backlog signal",
    );
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
    let overBacklog = false;
    try {
      const { deps: dOver, calls: cOver } = makeDeps({ pastDueBatches: overflow });
      ({ completed: over, backlogRemains: overBacklog } = await completePastBookings(dOver));
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
      overBacklog === true,
      "drain: an over-budget run reports backlog still waiting (#883 saturation signal)",
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

  // --- #2658: the cancel answers with WHICH call it cancelled ---
  // The embedded booker announces the cancel to its host page as cal.com's
  // `bookingCancelled`, which names the booking and its bounds. The route reads
  // them off this outcome rather than off a second query, and the boolean the
  // older callers read is the same decision, so the two cannot disagree.
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    const outcome = await cancelBookingWithDetail("tok1", CR, "customer", deps);
    assert(outcome.claimed === true, "detail: the first cancel claims the transition");
    assert(
      outcome.booking.id === "bk1" &&
        outcome.booking.startsAt === "2026-06-08T13:00:00.000Z" &&
        outcome.booking.endsAt === "2026-06-08T13:30:00.000Z",
      "detail: names the cancelled booking and its bounds",
    );
    assert(calls.claimCancellation.length === 1, "detail: the same cancel ran underneath");

    // The already cancelled row: claimed false, and STILL the booking, because the
    // host's cancel_booking is about the call, not about who got there first.
    const done = { booking: makeBooking({ status: "cancelled" }), bucket, eventType };
    const { deps: d2 } = makeDeps({ existing: done });
    const repeat = await cancelBookingWithDetail("tok1", CR, "customer", d2);
    assert(repeat.claimed === false, "detail: a repeat cancel does not claim");
    assert(repeat.booking.id === "bk1", "detail: a repeat cancel still names the booking");

    // And the boolean wrapper reads the same decision.
    const { deps: d3 } = makeDeps({ existing: { booking: makeBooking({}), bucket, eventType } });
    assert((await cancelBooking("tok1", CR, "customer", d3)) === true, "detail: cancelBooking is the claimed flag");
  }
}

await run();
finish();

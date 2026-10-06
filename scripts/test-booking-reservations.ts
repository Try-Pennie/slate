// The #429/#613 crash-safe create reservation drain: resume, webhook recovery, backoff.
//
// Split out of the old 3,229-line scripts/test-booking-orchestration.ts (#605);
// the shared BookingDeps fake lives in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-booking-reservations.ts
import {
  processBookingReservations,
} from "../src/lib/booking/orchestration.ts";
import type {
  BookingReservation,
} from "../src/lib/db/types.ts";
import { GoogleHttpError } from "../src/lib/google/http-error.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function run() {
  // --- create reservation drain resume after a crash (#429 P4 Phase C) ---
  {
    const reservation: BookingReservation = {
      id: "resv-crash",
      idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "slatedeadbeef",
      payload: {
        booking: {
          org_id: "org1",
          bucket_id: "bkt1",
          event_type_id: "et1",
          assigned_user_id: "a",
          agent_name: "Agent A",
          agent_email: "a@x.com",
          starts_at: "2026-06-08T13:00:00.000Z",
          ends_at: "2026-06-08T13:30:00.000Z",
          original_starts_at: "2026-06-08T13:00:00.000Z",
          original_ends_at: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          status: "confirmed",
          salesforce_id: "sf1",
          attendee_name: "Kris",
          attendee_email: "k@x.com",
          attendee_phone: "+12035615295",
          prefill: {},
          gcal_event_id: "slatedeadbeef",
          manage_token: "tok-resv",
          idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
          external_id: null,
          routing_trace: {
            bucket_code: "411",
            bucket_id: "bkt1",
            considered: ["a"],
            chosen_user_id: "a",
            fallback_applied: false,
          },
        },
        event: {
          summary: "Senior Loan Advisor Call with Kris",
          description: "desc",
          start: "2026-06-08T13:00:00.000Z",
          end: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          attendeeEmail: "k@x.com",
          attendeeName: "Kris",
        },
        bucketCode: "411",
      },
      status: "pending",
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    };
    const { deps, calls } = makeDeps({ drainableReservations: [reservation] });
    const res = await processBookingReservations(deps, 15);
    assert(res.processed === 1 && res.completed === 1, "drain: completes the crashed reservation");
    assert(calls.createEvent.length === 1, "drain: re-creates (reuses) the pinned calendar event");
    assert(calls.moveBusyBlock.length === 1, "drain: writes the write-through busy block");
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.created",
      "drain: fires booking.created exactly once",
    );
    assert(
      calls.deletedReservations.length === 1 && calls.deletedReservations[0] === "resv-crash",
      "drain: deletes the reservation on success",
    );
  }

  // --- create reservation drain: crash AFTER insert, BEFORE the webhook (#613) --
  // The booking was persisted but the reservation wasn't deleted and
  // booking.created never fired. On resume completeReservation finds the booking
  // already inserted; it must still deliver the post-insert side effects
  // (busyblock/recompute/notify) exactly once instead of short-circuiting and
  // dropping the webhook permanently. The reservation is the durable net, so the
  // drain that resumes it is what fires the previously-lost booking.created.
  {
    const already = makeBooking({
      id: "bk-613",
      idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
      routing_trace: {
        bucket_code: "411",
        bucket_id: "bkt1",
        considered: ["a"],
        chosen_user_id: "a",
        fallback_applied: false,
      },
    });
    const reservation: BookingReservation = {
      id: "resv-613",
      idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "slatedeadbeef",
      payload: {
        booking: {
          org_id: "org1",
          bucket_id: "bkt1",
          event_type_id: "et1",
          assigned_user_id: "a",
          agent_name: "Agent A",
          agent_email: "a@x.com",
          starts_at: "2026-06-08T13:00:00.000Z",
          ends_at: "2026-06-08T13:30:00.000Z",
          original_starts_at: "2026-06-08T13:00:00.000Z",
          original_ends_at: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          status: "confirmed",
          salesforce_id: "sf1",
          attendee_name: "Kris",
          attendee_email: "k@x.com",
          attendee_phone: "+12035615295",
          prefill: {},
          gcal_event_id: "slatedeadbeef",
          manage_token: "tok-resv",
          idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
          external_id: null,
          routing_trace: {
            bucket_code: "411",
            bucket_id: "bkt1",
            considered: ["a"],
            chosen_user_id: "a",
            fallback_applied: false,
          },
        },
        event: {
          summary: "Senior Loan Advisor Call with Kris",
          description: "desc",
          start: "2026-06-08T13:00:00.000Z",
          end: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          attendeeEmail: "k@x.com",
          attendeeName: "Kris",
        },
        bucketCode: "411",
      },
      status: "pending",
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    };
    // existingByKey models the booking that the crashed attempt already inserted:
    // findBookingByIdempotencyKey returns it, so completeReservation takes the
    // "already inserted" short-circuit branch.
    const { deps, calls } = makeDeps({
      drainableReservations: [reservation],
      existingByKey: already,
    });
    const res = await processBookingReservations(deps, 15);
    assert(
      res.processed === 1 && res.completed === 1,
      "#613 drain: completes the already-inserted reservation",
    );
    assert(
      calls.createEvent.length === 0,
      "#613 drain: booking already inserted, no second calendar event",
    );
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.created" &&
        calls.webhooks[0].dedupeKey === "bk-613",
      "#613 drain: fires the previously-lost booking.created exactly once (dedupe key = booking id)",
    );
    assert(
      calls.moveBusyBlock.length === 1 &&
        calls.moveBusyBlock[0].bookingId === "bk-613" &&
        calls.moveBusyBlock[0].userId === "a",
      "#613 drain: idempotent write-through busy block for the booking",
    );
    assert(
      calls.invalidateSlots.length === 1 && calls.invalidateSlots[0] === "411",
      "#613 drain: recomputes the booked bucket",
    );
    assert(
      calls.deletedReservations.length === 1 && calls.deletedReservations[0] === "resv-613",
      "#613 drain: deletes the reservation only after delivering side effects",
    );
  }

  // --- reservation drain: a transient failure bumps + backs off + alerts (#445) -
  {
    const reservation: BookingReservation = {
      id: "resv-stuck",
      idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "slatedeadbeef",
      payload: {
        booking: {
          org_id: "org1",
          bucket_id: "bkt1",
          event_type_id: "et1",
          assigned_user_id: "a",
          agent_name: "Agent A",
          agent_email: "a@x.com",
          starts_at: "2026-06-08T13:00:00.000Z",
          ends_at: "2026-06-08T13:30:00.000Z",
          original_starts_at: "2026-06-08T13:00:00.000Z",
          original_ends_at: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          status: "confirmed",
          salesforce_id: "sf1",
          attendee_name: "Kris",
          attendee_email: "k@x.com",
          attendee_phone: "+12035615295",
          prefill: {},
          gcal_event_id: "slatedeadbeef",
          manage_token: "tok-resv",
          idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
          external_id: null,
          routing_trace: {
            bucket_code: "411",
            bucket_id: "bkt1",
            considered: ["a"],
            chosen_user_id: "a",
            fallback_applied: false,
          },
        },
        event: {
          summary: "Senior Loan Advisor Call with Kris",
          description: "desc",
          start: "2026-06-08T13:00:00.000Z",
          end: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          attendeeEmail: "k@x.com",
          attendeeName: "Kris",
        },
        bucketCode: "411",
      },
      status: "pending",
      lease_until: null,
      attempts: 4, // a 5th failure this pass -> crosses the alert threshold
      last_error: "earlier failure",
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    };
    // insertBookingFails makes completeReservation throw (a transient DB failure).
    const { deps, calls } = makeDeps({
      drainableReservations: [reservation],
      insertBookingFails: true,
    });
    const res = await processBookingReservations(deps, 15);
    assert(res.processed === 1 && res.completed === 0 && res.failed === 1, "drain: a transient failure is counted, not completed");
    assert(calls.deletedReservations.length === 0, "drain: a transient failure does NOT delete the reservation (it retries later)");
    assert(calls.reservationBumps.length === 1, "drain: the failed reservation is bumped (attempts + backoff scheduled)");
    assert(calls.reservationBumps[0]?.attempts === 5, "drain: bump increments the prior attempt count (4 -> 5)");
    assert(res.stuck.length === 1 && res.stuck[0]?.id === "resv-stuck", "drain: a reservation past the alert threshold is reported stuck");

    // Terminal SlotUnavailable (slot genuinely taken): completeReservation deletes
    // the row and throws. The drain must NOT bump or alert (no phantom row) (#445).
    const terminal: BookingReservation = { ...reservation, id: "resv-terminal", attempts: 4 };
    const { deps: tDeps, calls: tCalls } = makeDeps({
      drainableReservations: [terminal],
      insertBookingConflict: true,
    });
    const tRes = await processBookingReservations(tDeps, 15);
    assert(tRes.failed === 1, "drain: a terminal slot-taken reservation is counted failed");
    assert(tCalls.deletedReservations.includes("resv-terminal"), "drain: terminal SlotUnavailable deletes the reservation");
    assert(tCalls.reservationBumps.length === 0, "drain: a terminal slot-taken reservation is NOT bumped (no backoff on a deleted row)");
    assert(tRes.stuck.length === 0, "drain: a terminal slot-taken reservation does NOT fire a stuck alert");

    // #3359: Google refusing the attendee's address is just as terminal. On
    // 2026-10-06 reservation 71d4bb58 sat at 13 attempts on the hourly backoff,
    // re-asking Google to invite an address it had already said it never would,
    // and paging on the way. No retry can change the address, so the row goes.
    const refusedEmail = () =>
      new GoogleHttpError(
        'events.insert failed: 400 {"error":{"errors":[{"domain":"global","reason":"invalid","message":"Invalid attendee email."}],"code":400}}',
        400,
        "invalid",
      );
    const refused: BookingReservation = { ...reservation, id: "resv-refused-email", attempts: 4 };
    const { deps: rDeps, calls: rCalls } = makeDeps({ drainableReservations: [refused] });
    rDeps.createEvent = async () => {
      throw refusedEmail();
    };
    const rRes = await processBookingReservations(rDeps, 15);
    assert(rRes.failed === 1 && rRes.completed === 0, "drain: a refused attendee email is counted failed, never completed");
    assert(
      rCalls.deletedReservations.includes("resv-refused-email"),
      "drain: a refused attendee email deletes the reservation (#3359)",
    );
    assert(rCalls.reservationBumps.length === 0, "drain: a refused attendee email is NOT bumped onto a backoff");
    assert(rRes.stuck.length === 0, "drain: a refused attendee email does NOT fire a stuck alert");
    assert(rCalls.insertBooking.length === 0, "drain: and no booking row is written for it");

    // Failure path: the delete itself fails. The row must then stay on the
    // ordinary retry (bumped, and reported once past the threshold), because a
    // row left pending with no backoff would be re-sent to Google every tick and
    // never reach anybody's attention.
    const { deps: fDeps, calls: fCalls } = makeDeps({
      drainableReservations: [{ ...refused, id: "resv-refused-undeletable" }],
    });
    fDeps.createEvent = async () => {
      throw refusedEmail();
    };
    fDeps.deleteReservation = async () => {
      throw new Error("supabase 503");
    };
    const fRes = await processBookingReservations(fDeps, 15);
    assert(fCalls.reservationBumps.length === 1, "drain: a refused email whose delete failed is bumped, so it backs off and retries");
    assert(fRes.stuck.length === 1, "drain: and it is reported once past the alert threshold, never left silent");

    // Narrowness: a different 400 from Google is a fault of OURS (a field we
    // built), so it stays on the retry and reaches the stuck alert like any other.
    const { deps: oDeps, calls: oCalls } = makeDeps({
      drainableReservations: [{ ...refused, id: "resv-other-400" }],
    });
    oDeps.createEvent = async () => {
      throw new GoogleHttpError(
        'events.insert failed: 400 {"error":{"errors":[{"domain":"global","reason":"invalid","message":"Invalid start time."}],"code":400}}',
        400,
        "invalid",
      );
    };
    const oRes = await processBookingReservations(oDeps, 15);
    assert(oCalls.deletedReservations.length === 0, "drain: another Google 400 does NOT delete the reservation");
    assert(oCalls.reservationBumps.length === 1 && oRes.stuck.length === 1, "drain: another Google 400 is bumped and reported");
  }

}

await run();
finish();

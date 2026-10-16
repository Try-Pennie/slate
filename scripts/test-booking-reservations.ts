// The #429/#613 crash-safe create reservation drain: resume, webhook recovery, backoff.
//
// Split out of the old 3,229-line scripts/test-booking-orchestration.ts (#605);
// the shared BookingDeps fake lives in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-booking-reservations.ts
import {
  createBooking,
  processBookingReservations,
  SlotUnavailableError,
  stableKeyFor,
  VerifyUnavailableError,
  type BookingDeps,
} from "../src/lib/booking/orchestration.ts";
import type {
  BookingReservation,
} from "../src/lib/db/types.ts";
import { GoogleHttpError } from "../src/lib/google/http-error.ts";
import { tierLadder } from "../src/lib/routing/tiers.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  input,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

// The crashed create the #3516 cases resume: the first case's reservation, as a
// fresh copy each call so one case's mutation never reaches another.
function crashedReservation(): BookingReservation {
  return {
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
}

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


  // --- #3516: the resume cannot send booking.created because the bucket is gone ---
  // The booking committed (by an earlier confirm, or by the one call save leaving
  // the reservation pending with its webhook `unbuilt`), and the bucket it was
  // booked into no longer resolves, so booking.created cannot be built. It used to
  // be skipped with no log and the reservation deleted, the only record that Regal
  // was still owed it. It is a failure now: the reservation stays pending, backs
  // off, and past the threshold reaches the drain's stuck alert, naming the bucket.
  {
    const already = makeBooking({
      id: "bk-3516",
      idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
      routing_trace: {
        bucket_code: "411",
        bucket_id: "bkt1",
        considered: ["a"],
        chosen_user_id: "a",
        fallback_applied: false,
      },
    });
    const reservation = (id: string, attempts: number): BookingReservation => ({
      ...crashedReservation(),
      id,
      attempts,
    });

    const { deps, calls } = makeDeps({
      drainableReservations: [reservation("resv-3516", 0)],
      existingByKey: already,
      unknownBucket: true,
    });
    const res = await processBookingReservations(deps, 15);
    assert(res.completed === 0 && res.failed === 1, "#3516 drain: an unbuildable booking.created is a failure, never completed");
    assert(calls.webhooks.length === 0, "#3516 drain: nothing is sent without a bucket to build it from");
    assert(
      calls.deletedReservations.length === 0,
      "#3516 drain: the reservation is NOT deleted, since it is the only record the webhook is owed",
    );
    assert(
      calls.reservationBumps.length === 1 &&
        /booking\.created/.test(calls.reservationBumps[0].lastError) &&
        /411/.test(calls.reservationBumps[0].lastError) &&
        /bk-3516/.test(calls.reservationBumps[0].lastError),
      "#3516 drain: it backs off with a last_error naming the webhook, the bucket and the booking",
    );

    // Past the threshold it is reported stuck, which is what pages.
    const { deps: sDeps } = makeDeps({
      drainableReservations: [reservation("resv-3516-stuck", 4)],
      existingByKey: already,
      unknownBucket: true,
    });
    const sRes = await processBookingReservations(sDeps, 15);
    assert(
      sRes.stuck.length === 1 && sRes.stuck[0].id === "resv-3516-stuck",
      "#3516 drain: past the alert threshold the reservation is reported stuck, so it pages",
    );

    // CONTROL: the same resume with the bucket resolving sends the webhook once and
    // deletes the reservation, so the failure above is the bucket and nothing else.
    const { deps: cDeps, calls: cCalls } = makeDeps({
      drainableReservations: [reservation("resv-3516-control", 0)],
      existingByKey: already,
    });
    const cRes = await processBookingReservations(cDeps, 15);
    assert(cRes.completed === 1 && cCalls.webhooks.length === 1, "#3516 control: a resolving bucket sends booking.created");
    assert(cCalls.deletedReservations.includes("resv-3516-control"), "#3516 control: and deletes the reservation");
  }

  const crashedReservationFixture = crashedReservation;
  // --- #3837: a lead's retry resumes its reservation under the drain's lease, and
  // walks the ladder when the advisor it pinned has been taken ---
  //
  // A confirm cut off after writing its reservation leaves it pending, pinned to one
  // advisor. The lead's retry finds it by the same idempotency key and resumes it. Two
  // things were wrong. The resume took no lease, so on a reservation old enough for the
  // drain the lead's retry and the drain could both complete it at once. And when the
  // pinned advisor had been taken in the meantime the lead was told the time was gone,
  // while any other confirm in that position walks the tier ladder and books a free
  // advisor at the same time (Dan, 2026-10-16: the resumed lead walks the tiers too).
  {
    // The crashed confirm's reservation, under the key the lead's retry carries.
    const retryKey = stableKeyFor(input);
    assert(retryKey !== null, "#3837 fixture: the retry has a stable key, the only kind a reservation is found by");
    const crashedReservation = (): BookingReservation => {
      const r = crashedReservationFixture();
      return { ...r, idempotency_key: retryKey!, payload: { ...r.payload, booking: { ...r.payload.booking, idempotency_key: retryKey! } } };
    };
    const [top, second] = tierLadder(input.bucketCode);
    // One lease table the resume and the drain share, as the real column is shared.
    const leaseTable = () => {
      const held = new Map<string, string>();
      const log: string[] = [];
      let n = 0;
      return {
        held,
        log,
        lease: async (id: string): Promise<string | null> => {
          log.push(`lease ${id}`);
          if (held.has(id)) return null;
          const token = `tok-${++n}`;
          held.set(id, token);
          return token;
        },
        release: async (id: string, token: string): Promise<void> => {
          log.push(`release ${id}`);
          if (held.get(id) === token) held.delete(id);
        },
      };
    };
    const settle = async <T>(run: () => Promise<T>): Promise<{ value: T | null; err: unknown }> => {
      try {
        return { value: await run(), err: null };
      } catch (err) {
        return { value: null, err };
      }
    };
    // The pinned advisor a holds the time now (another lead booked it); the top rung
    // shows nobody free, and the rung below has c.
    const takenFixture = {
      reservation: crashedReservation(),
      candidatesByCode: { [top]: [] as string[], [second]: ["c"] },
      memberCount: 1,
      freeEmails: new Set(["a@x.com", "c@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    };

    // 1. The pinned advisor was taken: the stale reservation is rolled back, then the
    //    lead walks the ladder from the top for the same time and is booked below.
    {
      const leases = leaseTable();
      const { deps, calls } = makeDeps({ ...takenFixture, reservation: crashedReservation() });
      deps.leaseReservation = leases.lease;
      deps.releaseReservationLease = leases.release;
      const { value: res, err } = await settle(() => createBooking(input, deps));
      assert(err === null, `#3837 taken pin: the resumed lead is booked rather than told the time is taken (got ${String(err)})`);
      assert(res?.booking.assigned_user_id === "c", `#3837 taken pin: booked with the free advisor on the rung below (got ${res?.booking.assigned_user_id})`);
      assert(
        calls.resolveBucketByCode.includes(top) && calls.resolveBucketByCode.includes(second),
        `#3837 taken pin: the walk starts at the top of the ladder (got ${calls.resolveBucketByCode.join(",")})`,
      );
      assert(calls.createEvent[0]?.email === "a@x.com", "#3837 taken pin: the reservation really was resumed on the advisor it pinned first");
      assert(
        calls.deleteEvent.some((e) => e.id === "gcal-1"),
        `#3837 taken pin: the resumed event on the taken advisor's calendar is removed (got ${JSON.stringify(calls.deleteEvent)})`,
      );
      assert(
        calls.deletedReservations[0] === "resv-crash",
        `#3837 taken pin: the stale reservation is deleted first, so the drain has nothing left to resume (got ${calls.deletedReservations.join(",")})`,
      );
      assert(
        calls.reservations.length === 1 &&
          calls.reservations[0].pinned_user_id === "c" &&
          calls.reservations[0].idempotency_key === crashedReservation().idempotency_key,
        `#3837 taken pin: the walk reserves under the SAME key, so a third retry is still guarded by it (got ${JSON.stringify(calls.reservations)})`,
      );
      assert(
        leases.log.join(";") === "lease resv-crash;release resv-crash",
        `#3837 taken pin: the resume holds the drain's lease while it works the reservation, and gives it back (got ${leases.log.join(";")})`,
      );
      assert(leases.held.size === 0, "#3837 taken pin: no lease is left held");
    }

    // 2. A ladder that is genuinely full still answers taken, after the walk asked it.
    {
      const { deps, calls } = makeDeps({ ...takenFixture, reservation: crashedReservation(), candidatesByCode: { [top]: [], [second]: [] } });
      const { err } = await settle(() => createBooking(input, deps));
      assert(err instanceof SlotUnavailableError, `#3837 full ladder: the lead is told the time is taken (got ${String(err)})`);
      assert(calls.resolveBucketByCode.includes(second), "#3837 full ladder: only after walking the rungs below");
      assert(calls.deletedReservations.includes("resv-crash"), "#3837 full ladder: the stale reservation is gone, nothing orphaned for the drain");
      assert(calls.reservations.length === 0, "#3837 full ladder: nothing new is reserved when nobody is free");
    }

    // 3. The drain holds the lease: the lead's retry does not touch the reservation,
    //    is not walked (the reservation still names this key), and is told to try again.
    {
      const { deps, calls } = makeDeps({ ...takenFixture, reservation: crashedReservation() });
      deps.leaseReservation = async () => null;
      const { err } = await settle(() => createBooking(input, deps));
      assert(
        err instanceof VerifyUnavailableError && err.name === "ReservationHeldError",
        `#3837 lease held: a retryable refusal of its own kind (got ${String(err)})`,
      );
      assert(calls.createEvent.length === 0, "#3837 lease held: no calendar write from the retry");
      assert(calls.insertBooking.length === 0 && calls.reservations.length === 0, "#3837 lease held: no booking and no second reservation");
      assert(calls.deletedReservations.length === 0, "#3837 lease held: the holder's reservation is left to the holder");
    }

    // 4. The lease is held because the holder has just finished: the booking it made
    //    is the answer, read by the key, rather than a refusal.
    {
      const made = makeBooking({ id: "bk-by-drain", idempotency_key: crashedReservation().idempotency_key });
      const { deps, calls } = makeDeps({ ...takenFixture, reservation: crashedReservation() });
      let lookups = 0;
      deps.findBookingByIdempotencyKey = async () => (lookups++ === 0 ? null : made);
      deps.leaseReservation = async () => null;
      const { value: res, err } = await settle(() => createBooking(input, deps));
      assert(
        err === null && res?.booking.id === "bk-by-drain",
        `#3837 lease held, booking made: the holder's booking is the answer (got ${String(err)}, ${res?.booking.id})`,
      );
      assert(calls.createEvent.length === 0, "#3837 lease held, booking made: the retry writes nothing");
    }

    // 5. The lease claim itself fails: nothing is completed or walked, and it is the
    //    retryable outage (a claim nobody could confirm is not a claim).
    {
      const { deps, calls } = makeDeps({ ...takenFixture, reservation: crashedReservation() });
      deps.leaseReservation = async () => {
        throw new Error("reservation_lease: statement refused");
      };
      const { err } = await settle(() => createBooking(input, deps));
      assert(
        err instanceof VerifyUnavailableError &&
          err.name !== "ReservationHeldError" &&
          /statement refused/.test(String((err as Error).cause)),
        `#3837 failed claim: the retryable outage, carrying the database's refusal (got ${String(err)})`,
      );
      assert(calls.createEvent.length === 0 && calls.reservations.length === 0, "#3837 failed claim: nothing written and nothing walked");
    }

    // 6. The rollback of the stale reservation fails: no walk, since a walk would
    //    reserve under the same key and adopt the very reservation still standing.
    {
      const leases = leaseTable();
      const { deps, calls } = makeDeps({ ...takenFixture, reservation: crashedReservation() });
      deps.leaseReservation = leases.lease;
      deps.releaseReservationLease = leases.release;
      deps.deleteReservation = async () => {
        throw new Error("supabase 503");
      };
      const { err } = await settle(() => createBooking(input, deps));
      assert(err instanceof Error && /503/.test(err.message), `#3837 failed rollback: its own error reaches the lead (got ${String(err)})`);
      assert(calls.reservations.length === 0, "#3837 failed rollback: the ladder is not walked over a reservation still standing");
      assert(
        leases.held.size === 0 && leases.log.includes("release resv-crash"),
        `#3837 failed rollback: the lease is given back, so the drain retries the row (got ${leases.log.join(";")})`,
      );
    }

    // 7. An untaken pin completes as before, under the lease, and gives it back.
    {
      const leases = leaseTable();
      const { deps } = makeDeps({ ...takenFixture, reservation: crashedReservation(), insertBookingConflictFor: new Set<string>() });
      deps.leaseReservation = leases.lease;
      deps.releaseReservationLease = leases.release;
      const res = await createBooking(input, deps);
      assert(res.booking.assigned_user_id === "a", "#3837 free pin: the resume books the advisor it pinned, as before");
      assert(
        leases.log.join(";") === "lease resv-crash;release resv-crash",
        `#3837 free pin: under the lease (got ${leases.log.join(";")})`,
      );
    }

    // 8. A lead's resume and the drain on ONE reservation: only one of them works it.
    //    The drain runs in the middle of the resume's calendar write.
    {
      const leases = leaseTable();
      const { deps, calls } = makeDeps({
        ...takenFixture,
        reservation: crashedReservation(),
        insertBookingConflictFor: new Set<string>(),
        drainableReservations: [crashedReservation()],
      });
      deps.leaseReservation = leases.lease;
      deps.releaseReservationLease = leases.release;
      const drainDeps: BookingDeps = { ...deps };
      const createEvent = deps.createEvent;
      let drained: { processed: number; completed: number; failed: number } | null = null;
      deps.createEvent = async (...args) => {
        if (drained === null) drained = await processBookingReservations(drainDeps, 15);
        return createEvent(...args);
      };
      await createBooking(input, deps);
      const seen = drained as { processed: number; completed: number; failed: number } | null;
      assert(seen !== null, "#3837 resume and drain: the fixture really ran the drain mid resume");
      assert(
        seen?.processed === 1 && seen.completed === 0 && seen.failed === 0,
        `#3837 resume and drain: the drain finds the lease taken and leaves the row alone (got ${JSON.stringify(seen)})`,
      );
      assert(calls.createEvent.length === 1, `#3837 resume and drain: one calendar write, never two (got ${calls.createEvent.length})`);
    }
  }

  // --- the drain's read failing is the drain failing ---
  // A read that throws must reach the lane (which counts it toward
  // reservation_drain_failing), never resolve as an empty tick.
  {
    const { deps } = makeDeps({});
    deps.loadDrainableReservations = async () => {
      throw new Error("booking_reservations drain read failed: statement timeout");
    };
    let threw: unknown = null;
    try {
      await processBookingReservations(deps, 15);
    } catch (err) {
      threw = err;
    }
    assert(threw instanceof Error && /statement timeout/.test(threw.message), "drain: a failed read throws out of the drain rather than reading as empty");
  }

  // --- #3847: the booking committed and was then cancelled or completed ---------
  // The resume used to look for an already committed booking through the ACTIVE
  // only replay read, so a reservation whose booking was cancelled (or completed)
  // after it committed read as never committed, and the drain made the booking
  // AGAIN: a calendar event for a call the lead called off, a new booking row and a
  // booking.created to Regal. The resume now reads the newest booking on the key
  // whatever its status, and one made by this reservation (created after it) that
  // is no longer active settles the reservation: deleted, nothing recreated.
  const RESV_AT = "2026-06-01T10:00:00.000Z";
  const ownBooking = (status: "cancelled" | "completed") =>
    makeBooking({
      id: `bk-3847-${status}`,
      status,
      idempotency_key: crashedReservation().idempotency_key,
      created_at: "2026-06-01T10:00:04.000Z",
    });
  for (const status of ["cancelled", "completed"] as const) {
    const reservation = { ...crashedReservation(), id: `resv-3847-${status}`, created_at: RESV_AT, attempts: 6 };
    const { deps, calls } = makeDeps({ drainableReservations: [reservation], existingByKey: ownBooking(status) });
    const res = await processBookingReservations(deps, 15);
    assert(calls.createEvent.length === 0, `#3847 ${status}: no calendar event is made for it again (got ${calls.createEvent.length})`);
    assert(calls.insertBooking.length === 0, `#3847 ${status}: no booking is made again (got ${calls.insertBooking.length})`);
    assert(calls.webhooks.length === 0, `#3847 ${status}: and no booking.created is sent (got ${calls.webhooks.length})`);
    assert(calls.deletedReservations.includes(reservation.id), `#3847 ${status}: the reservation is settled by deleting it`);
    assert(res.failed === 0 && res.stuck.length === 0, `#3847 ${status}: settling is not a failure, so it neither backs off nor pages`);
    assert(calls.reservationBumps.length === 0, `#3847 ${status}: and charges no attempt`);
  }

  // Control: a cancelled booking OLDER than the reservation belongs to an earlier
  // booking on the same key (a lead who cancelled and then booked the same time
  // again), so this reservation is a new create and is completed as one.
  {
    const reservation = { ...crashedReservation(), id: "resv-3847-rebook", created_at: RESV_AT };
    const earlier = makeBooking({
      id: "bk-3847-earlier",
      status: "cancelled",
      idempotency_key: reservation.idempotency_key,
      created_at: "2026-05-28T09:00:00.000Z",
    });
    const { deps, calls } = makeDeps({ drainableReservations: [reservation], existingByKey: earlier });
    const res = await processBookingReservations(deps, 15);
    assert(res.completed === 1 && calls.createEvent.length === 1, "#3847 control: a rebook after an earlier cancel is still completed");
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.created",
      "#3847 control: and its booking.created is sent",
    );
  }

  // The failure path: the lookup cannot be read. Nothing is created and nothing is
  // deleted; the reservation backs off like any other failed attempt.
  {
    const reservation = { ...crashedReservation(), id: "resv-3847-unread", created_at: RESV_AT };
    const { deps, calls } = makeDeps({ drainableReservations: [reservation], latestByKeyFails: true });
    const res = await processBookingReservations(deps, 15);
    assert(calls.createEvent.length === 0, "#3847 unreadable: no event is made off a lookup that failed");
    assert(!calls.deletedReservations.includes(reservation.id), "#3847 unreadable: and the reservation is not deleted");
    assert(res.failed === 1 && calls.reservationBumps.length === 1, "#3847 unreadable: it is a failed attempt that backs off");
  }

  // A lead's own re-submit that finds such a reservation pending: the old
  // reservation is settled and the confirm books afresh, as the lead asked, rather
  // than resurrecting the cancelled booking from the old pin.
  {
    const reservation = { ...crashedReservation(), id: "resv-3847-resubmit", created_at: RESV_AT };
    const { deps, calls } = makeDeps({ reservation, existingByKey: ownBooking("cancelled") });
    const made = await createBooking(input, deps);
    assert(calls.deletedReservations.includes(reservation.id), "#3847 re-submit: the settled reservation is deleted");
    assert(calls.reservations.length === 1, `#3847 re-submit: the confirm writes a fresh reservation (got ${calls.reservations.length})`);
    assert(made.booking.id !== "bk-3847-cancelled", "#3847 re-submit: and answers a new booking, never the cancelled one");
  }
}

await run();
finish();

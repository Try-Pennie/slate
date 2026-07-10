// createBooking: verify-on-book, rollback, idempotency, test buckets, empty pool.
//
// Split out of the old 3,229-line scripts/test-booking-orchestration.ts (#605);
// the shared BookingDeps fake lives in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-booking-create.ts
import {
  createBooking,
  processBookingReservations,
  SlotUnavailableError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  UnknownBucketError,
  type CreateBookingInput,
} from "../src/lib/booking/orchestration.ts";
import type {
  BookingReservation,
} from "../src/lib/db/types.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  input,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function run() {
  // --- createBooking: happy path ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const res = await createBooking(input, deps);
    assert(res.booking.id === "bk-new", "create returns the persisted booking");
    assert(
      calls.roundRobinPreview.at(-1) !== true,
      "real create routes in NON-preview mode (the shadow study sees only real assignments)",
    );
    assert(
      res.booking.original_starts_at === "2026-06-08T13:00:00.000Z" &&
        res.booking.original_ends_at === "2026-06-08T13:30:00.000Z",
      "create: preserves the original scheduled time on the booking (#300)",
    );
    assert(
      res.manageUrl === "https://slate.test/booking/manage/tok-fixed",
      "manage URL uses base + manage token",
    );
    assert(calls.createEvent.length === 1, "create: one calendar event");
    // #429 P4: reservation-first, pins the agent + a deterministic client id
    // BEFORE the event, then deletes the reservation once the booking persists.
    assert(
      calls.reservations.length === 1 &&
        calls.reservations[0].pinned_user_id === "a" &&
        calls.reservations[0].gcal_client_id.startsWith("slate"),
      "create: writes a reservation pinning the agent + deterministic client id",
    );
    assert(
      calls.deletedReservations.length === 1,
      "create: deletes the reservation on success (delete-on-deliver)",
    );
    // Write-through via moveBusyBlock (delete-by-booking + insert, #429 P3) so the
    // create and a crash-resume are idempotent, a resume can't leave a duplicate
    // block (#613). moveBusyBlock inserts a 'slate' block for the booking.
    assert(
      calls.moveBusyBlock.length === 1 &&
        calls.moveBusyBlock[0].userId === "a" &&
        calls.moveBusyBlock[0].bookingId === "bk-new",
      "create: write-through busy block for the booked agent",
    );
    assert(
      calls.moveBusyBlock[0].startIso === "2026-06-08T13:00:00.000Z" &&
        calls.moveBusyBlock[0].endIso === "2026-06-08T13:30:00.000Z",
      "create: busy block spans the booked slot (30m)",
    );
    // #586: once the event is Slate-owned, clear any stray source=gcal mirror a
    // push-sync may have cached while racing the create (before the booking
    // committed). Keyed by the booked agent + the created event id.
    assert(
      calls.deleteGcalMirror.length === 1 &&
        calls.deleteGcalMirror[0].userId === "a" &&
        calls.deleteGcalMirror[0].gcalEventId === "gcal-1",
      "create: heals any raced gcal mirror for the booked event (#586)",
    );
    assert(calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.created", "create: fires booking.created");
    assert(calls.webhooks[0].dedupeKey === res.booking.id, "create: webhook dedupe key is the booking id (#436)");
    assert(calls.deleteEvent.length === 0, "create: no rollback on success");
    assert(
      calls.invalidateSlots.length === 1 && calls.invalidateSlots[0] === "411",
      "create: invalidates cached slots for the booked bucket exactly once",
    );
  }

  // --- createBooking: the #586 gcal-mirror heal is BEST-EFFORT ---
  // The booking has already committed by the time the heal runs, so a transient
  // failure of the mirror delete must NOT fail the booking. It is attempted, it
  // throws, and the create still returns the persisted booking with its webhook.
  {
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      deleteGcalMirrorThrows: true,
    });
    const res = await createBooking(input, deps);
    assert(res.booking.id === "bk-new", "heal-fail: booking still succeeds when the mirror delete throws");
    assert(calls.deleteGcalMirror.length === 1, "heal-fail: the mirror delete was attempted");
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.created",
      "heal-fail: booking.created still fires (the commit's side effects are not lost)",
    );
    assert(calls.deleteEvent.length === 0, "heal-fail: no rollback of the calendar event");
  }

  // --- createBooking: a keyless (anonymous) booking is crash-safe too (#666) ---
  // No email/phone/salesforceId and no caller key -> no STABLE idempotency key.
  // Such a booking used to fall through to the legacy path, which fired
  // booking.created inline with no reservation and no outbox: a crash after the
  // insert but before the webhook dropped it permanently, with nothing to
  // redeliver. It must now get the SAME reservation-backed durable net every
  // keyed booking has (a synthesized key), so the drain can resume it.
  {
    const keyless: CreateBookingInput = {
      bucketCode: "411",
      startIso: "2026-06-08T13:00:00.000Z",
      timezone: "America/New_York",
      attendee: { name: "Anon Lead" }, // no email/phone -> idempotencyKeyFor is null
      prefill: {},
    };
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const res = await createBooking(keyless, deps);
    assert(res.booking.id === "bk-new", "keyless create: returns the persisted booking");
    assert(
      calls.reservations.length === 1,
      "keyless create: writes a reservation (the durable crash-safety net #666)",
    );
    const rk = calls.reservations[0]?.idempotency_key ?? "";
    assert(
      rk.length > 0 && !rk.includes("|"),
      "keyless create: reservation uses a synthesized key, not a derived (email/phone) key",
    );
    assert(
      calls.reservations[0]?.gcal_client_id.startsWith("slate"),
      "keyless create: pins a deterministic Google client id (retry-safe)",
    );
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.created",
      "keyless create: fires booking.created",
    );
    assert(
      calls.deletedReservations.length === 1,
      "keyless create: deletes the reservation on success (delete-on-deliver)",
    );
  }

  // --- keyless create: crash AFTER insert, BEFORE the webhook is recoverable (#666) ---
  // The failure path: a keyless booking's reservation persisted and the booking
  // inserted, then the process died before booking.created fired. The drain must
  // resume it from the reservation and deliver the previously-lost webhook
  // exactly once -- the exact drop #666 closes for anonymous bookings.
  {
    const already = makeBooking({
      id: "bk-anon",
      salesforce_id: null,
      attendee_email: null,
      attendee_phone: null,
      idempotency_key: "anon_synth_666",
      routing_trace: {
        bucket_code: "411",
        bucket_id: "bkt1",
        considered: ["a"],
        chosen_user_id: "a",
        fallback_applied: false,
      },
    });
    const reservation: BookingReservation = {
      id: "resv-anon",
      idempotency_key: "anon_synth_666",
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
          salesforce_id: null,
          attendee_name: "Anon Lead",
          attendee_email: null,
          attendee_phone: null,
          prefill: {},
          gcal_event_id: "slatedeadbeef",
          manage_token: "tok-anon",
          idempotency_key: "anon_synth_666",
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
          summary: "Senior Loan Advisor Call with Anon Lead",
          description: "desc",
          start: "2026-06-08T13:00:00.000Z",
          end: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
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
    const { deps, calls } = makeDeps({
      drainableReservations: [reservation],
      existingByKey: already, // the booking the crashed attempt already inserted
    });
    const res = await processBookingReservations(deps, 15);
    assert(
      res.processed === 1 && res.completed === 1,
      "#666 drain: resumes the crashed keyless reservation",
    );
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.created" &&
        calls.webhooks[0].dedupeKey === "bk-anon",
      "#666 drain: redelivers the previously-lost booking.created exactly once",
    );
    assert(
      calls.deletedReservations.length === 1 && calls.deletedReservations[0] === "resv-anon",
      "#666 drain: deletes the reservation only after delivering the webhook",
    );
  }

  // --- processBookingReservations drains a backlog CONCURRENTLY (AUD-062) ---
  // Each reservation is leased before completeReservation runs, so a large
  // backlog clears in far fewer ticks without two drains double-running a row.
  // Probe concurrency at the lease (called once per row): a serial loop never
  // has two leases in flight, the bounded-concurrent drain does.
  {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `resv-c${i}`,
      idempotency_key: `k-c${i}`,
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: `slate-c${i}`,
      payload: {},
      status: "pending" as const,
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    })) as unknown as Parameters<typeof makeDeps>[0]["drainableReservations"];
    const { deps } = makeDeps({ drainableReservations: rows ?? undefined });
    let inFlight = 0;
    let maxInFlight = 0;
    const leased: string[] = [];
    const released: string[] = [];
    deps.leaseReservation = async (id: string) => {
      leased.push(id);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // yield so peers can start
      inFlight--;
      return true;
    };
    deps.releaseReservationLease = async (id: string) => { released.push(id); };
    const res = await processBookingReservations(deps, 15);
    assert(res.processed === 6, "reservation drain processes every backlog row");
    assert(maxInFlight > 1, "reservation drain runs rows concurrently, not one-at-a-time");
    assert(released.length === 6, "reservation drain releases the lease for every leased row");
  }

  // --- createBooking: a test bucket is unbookable on the public path (#396) ---
  {
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      testBucket: true,
    });
    let err: unknown;
    try {
      await createBooking(input, deps); // no allowTestBuckets -> public lead
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof UnknownBucketError,
      "create: public path rejects a test bucket as Unknown (real leads can't book it)",
    );
    assert(
      calls.createEvent.length === 0 && calls.webhooks.length === 0,
      "create: test-bucket rejection happens before any calendar event / webhook",
    );
  }

  // --- createBooking: the authed smoke key CAN book a test bucket (#396) ---
  {
    const { deps } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      testBucket: true,
    });
    const res = await createBooking({ ...input, allowTestBuckets: true }, deps);
    assert(
      res.booking.id === "bk-new",
      "create: allowTestBuckets lets the key-authed smoke test book a test bucket",
    );
  }

  // --- createBooking: rollback on persist failure ---
  {
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      insertBookingFails: true,
    });
    let threw = false;
    try {
      await createBooking(input, deps);
    } catch {
      threw = true;
    }
    assert(threw, "create: throws when persist fails");
    assert(calls.createEvent.length === 1, "create-fail: calendar event was created");
    assert(
      calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-1",
      "create-fail: rolls back the created calendar event",
    );
    assert(calls.moveBusyBlock.length === 0, "create-fail: no busy block written");
    assert(calls.webhooks.length === 0, "create-fail: no webhook fired");
    assert(calls.invalidateSlots.length === 0, "create-fail: no invalidation when booking throws before write-through");
  }

  // --- createBooking: unique-slot conflict (verify-on-book race loser) ---
  {
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      insertBookingConflict: true,
    });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof SlotUnavailableError, "create-conflict: unique-slot conflict throws SlotUnavailableError");
    assert(
      calls.createEvent.length === 1 && calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-1",
      "create-conflict: rolls back the calendar event",
    );
    assert(calls.moveBusyBlock.length === 0 && calls.webhooks.length === 0, "create-conflict: no busy block / webhook");
  }

  // --- idempotency: double-submit returns the existing booking (fast path) ---
  {
    const existing = makeBooking({ id: "bk-existing", manage_token: "tok-existing" });
    const { deps, calls } = makeDeps({ existingByKey: existing });
    const res = await createBooking(input, deps);
    assert(res.booking.id === "bk-existing", "idempotency: returns the existing booking on replay");
    assert(
      res.manageUrl === "https://slate.test/booking/manage/tok-existing",
      "idempotency: manage URL points at the existing booking",
    );
    assert(calls.createEvent.length === 0, "idempotency: no calendar event created on replay");
    assert(
      calls.moveBusyBlock.length === 0 && calls.webhooks.length === 0,
      "idempotency: no insert / busy block / webhook on replay",
    );
  }

  // --- idempotency: concurrent duplicate loses the insert race, gets the winner ---
  {
    const winner = makeBooking({ id: "bk-winner", manage_token: "tok-winner" });
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      insertBookingConflict: true,
      conflictWinner: winner, // not visible at pre-check, found after the conflict
    });
    const res = await createBooking(input, deps);
    assert(res.booking.id === "bk-winner", "idempotency race: returns the winning booking, not an error");
    assert(
      res.manageUrl === "https://slate.test/booking/manage/tok-winner",
      "idempotency race: manage URL points at the winner",
    );
    // #429 P4: the loser adopts the winner's reservation (same pinned agent +
    // deterministic client id), so its createEvent REUSES the winner's event
    // (Google 409) rather than making a separate one. The event id is therefore
    // shared with the winner, it must NOT be rolled back (that would delete the
    // winner's event). The loser just returns the winner and cleans up its row.
    assert(
      calls.deleteEvent.length === 0,
      "idempotency race: loser reuses the winner's event, nothing rolled back",
    );
    assert(
      calls.deletedReservations.length === 1,
      "idempotency race: loser cleans up the reservation",
    );
  }

  // --- createBooking: verify-on-book walks past busy A to free B ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a", "b"], freeEmails: new Set(["b@x.com"]) });
    const res = await createBooking(input, deps);
    assert(res.booking.assigned_user_id === "b", "create: skips busy A, books free B");
    assert(
      calls.verifyFree.length === 1 &&
        JSON.stringify(calls.verifyFree[0]) === JSON.stringify(["a@x.com", "b@x.com"]),
      "create: verifies A and B together in one batched wave",
    );
  }

  // --- createBooking: no free candidate ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a", "b"], freeEmails: new Set() });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof SlotUnavailableError, "create: SlotUnavailableError when none free");
    assert(
      !(err instanceof VerifyUnavailableError),
      "create: a genuinely-full slot is NOT an outage",
    );
    assert(calls.createEvent.length === 0, "create: no calendar event when no agent is free");
  }

  // --- createBooking: EMPTY pool (misconfigured bucket) vs full slot (#358) ---
  {
    const { deps, calls } = makeDeps({ candidates: [], freeEmails: new Set() });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof NoEligibleAgentsError,
      "create: NoEligibleAgentsError when the bucket has zero eligible agents",
    );
    assert(
      err instanceof NoEligibleAgentsError && err.bucketCode === "411",
      "create: NoEligibleAgentsError carries the bucket code (for the #327 alert)",
    );
    assert(
      !(err instanceof SlotUnavailableError),
      "create: an empty pool is DISTINCT from a genuinely-full slot",
    );
    assert(calls.createEvent.length === 0, "create-empty-pool: no calendar event");
  }

  // --- createBooking: unknown bucket code (#358) ---
  {
    const { deps } = makeDeps({ unknownBucket: true });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof UnknownBucketError,
      "create: UnknownBucketError when the bucket code resolves to nothing",
    );
  }

  // --- createBooking: verify-on-book outage (couldn't check) vs full slot ---
  {
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(),
      unverifiedEmails: new Set(["a@x.com"]), // a couldn't be checked (outage)
    });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof VerifyUnavailableError,
      "create: an unverifiable candidate throws VerifyUnavailableError, not SlotUnavailableError",
    );
    assert(calls.createEvent.length === 0, "create-outage: no calendar event written");
  }

}

await run();
finish();

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
  AttendeeEmailRefusedError,
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
import { GoogleHttpError } from "../src/lib/google/http-error.ts";
import { INVALID_EMAIL } from "../src/lib/attendee.ts";

const { assert, finish } = createAsserter();

async function run() {
  // --- createBooking: happy path ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const res = await createBooking(input, deps);
    assert(res.booking.id === "bk-new", "create returns the persisted booking");
    assert(
      calls.roundRobinPreview.at(-1) !== true,
      "real create routes in NON-preview mode (so a degraded share on a real assignment still alerts)",
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
    // #3324: and hands over the booked advisor and window, so the splice can take
    // the time out of every pool that advisor serves, not just the booked code's.
    assert(
      JSON.stringify(calls.invalidateSlotsBooked[0]) ===
        JSON.stringify({ userId: "a", startsAt: "2026-06-08T13:00:00.000Z", endsAt: "2026-06-08T13:30:00.000Z" }),
      "create: the refresh carries the booked advisor and window (#3324)",
    );
    // #504: the routing decision log is now injected through deps, so a test can
    // assert it directly instead of inferring it from a swallowed-error log line.
    assert(
      calls.recordRoutingDecision.length === 1 &&
        calls.recordRoutingDecision[0].outcome === "booked" &&
        calls.recordRoutingDecision[0].chosenUserId === "a" &&
        calls.recordRoutingDecision[0].bookingId === res.booking.id,
      "create: records one 'booked' routing decision for the chosen agent",
    );
  }

  // --- #884: the create confirm DEFERS the booking.created send ---
  // A user-facing request carries a send scheduler on its deps; fire() routes the
  // outbound POST through it so the confirm returns without waiting on the
  // Regal/Cadence round-trip. The delivery row is still recorded synchronously, so
  // the retry sweep is the backstop if a deferred send is ever dropped.
  {
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      deferSend: () => {},
    });
    await createBooking(input, deps);
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.created" &&
        calls.webhooks[0].deferred === true,
      "#884: create confirm defers the booking.created send off the response path",
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
      calls.webhooks[0].deferred === false,
      "#884 drain: the reservation drain sends inline (no scheduler), not deferred",
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
      return `lease-${id}`;
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
    // #3215 reversed the live rollback here: the reservation stays pending and a
    // resume adopts this event by its deterministic id, so deleting it would hand
    // the resume a cancelled event. Its deletion is queued for the drain instead,
    // which holds it until nothing can adopt it (scripts/test-booking-insert-deadline.ts).
    assert(calls.deleteEvent.length === 0, "create-fail: the event a pending reservation pins is not deleted live");
    assert(
      calls.enqueueEventDeletion.length === 1 &&
        calls.enqueueEventDeletion[0].eventId === "gcal-1" &&
        calls.enqueueEventDeletion[0].bookingId === null,
      "create-fail: the created calendar event's deletion is queued for the drain",
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

  // --- #3359: Google refuses the attendee's address on the create ---
  // The lead must be told about THEIR email, not handed a 500, and nothing may
  // be left behind for the drain to retry: no retry can change the address.
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const google = new GoogleHttpError(
      'events.insert failed: 400 {"error":{"errors":[{"domain":"global","reason":"invalid","message":"Invalid attendee email."}],"code":400}}',
      400,
      "invalid",
    );
    deps.createEvent = async () => {
      throw google;
    };
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof AttendeeEmailRefusedError, "refused-email: the create throws the typed refusal, not the raw Google error");
    assert(
      err instanceof AttendeeEmailRefusedError && err.message === INVALID_EMAIL && err.cause === google,
      "refused-email: it carries the lead's own sentence and keeps Google's answer as its cause",
    );
    assert(calls.deletedReservations.length === 1, "refused-email: the reservation is deleted at once, so the drain never retries it");
    assert(calls.insertBooking.length === 0, "refused-email: no booking row is written");
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
    // #3495: the wave carries the advisor ids the emails were read from, so the live check
    // reads each calendar by id and never looks the advisors up again by email.
    assert(
      JSON.stringify(calls.verifyFreeIds[0]) === JSON.stringify({ "a@x.com": "a", "b@x.com": "b" }),
      `create: the wave is handed each email's advisor id (got ${JSON.stringify(calls.verifyFreeIds[0])})`,
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

  // --- #2072: the booking records where it came from ---
  // Read on the SERVER from the prefill every route already sends, so the public
  // booker and the direct booking API are covered by the one create path.
  const sourceOf = async (prefill: Record<string, string>, apiCaller?: "regal" | "trypennie" | "canary") => {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    };
    try {
      await createBooking({ ...input, prefill, ...(apiCaller ? { apiCaller } : {}) }, deps);
    } finally {
      console.warn = realWarn;
    }
    return { row: calls.insertBooking.at(-1), warned };
  };
  {
    const { row, warned } = await sourceOf({ xbc: "411", source: "offerhub" });
    assert(row?.source === "offerhub", "create: a known page source is written onto the booking row");
    assert(!warned.some((l) => l.includes("tag=booking-source")), "create: a known source logs nothing");
  }
  {
    const { row, warned } = await sourceOf({ xbc: "411" });
    assert(row?.source === "not-given", "create: a link with no source records not-given, never null or empty");
    assert(!warned.some((l) => l.includes("tag=booking-source")), "create: an absent source is not a warning");
  }
  {
    // #2876: the booking API's caller is known here, so a call naming no page
    // records WHO booked rather than not-given, which the per page alarm would
    // otherwise read as a booking that might be any page's.
    const { row } = await sourceOf({ xbc: "411" }, "regal");
    assert(row?.source === "api-regal", `create: an API booking naming no page records its caller (got ${row?.source})`);
    const named = await sourceOf({ xbc: "411", source: "booking" }, "trypennie");
    assert(named.row?.source === "booking", "create: a page the API caller names is still recorded as that page");
  }
  {
    const { row, warned } = await sourceOf({ xbc: "411", source: "offer-hub" });
    assert(
      row?.source === "unrecognised",
      "create: an unknown source is recorded as unrecognised, not folded into not-given, and the booking is still made",
    );
    assert(
      warned.some((l) => l.includes("tag=booking-source") && l.includes("offer-hub")),
      "create: the raw unrecognised value is logged so the broken link can be found",
    );
    assert(
      row?.prefill != null && (row.prefill as Record<string, string>).source === "offer-hub",
      "create: the raw value stays in prefill, untouched",
    );
  }

  // --- #2728: the booking records the origin of the page that framed the booker ---
  // Reduced on the SERVER, whatever the client sent: a path and a query can carry a
  // lead's details and must never reach the row.
  const referrerOf = async (referrerOrigin: string | null | undefined) => {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    await createBooking({ ...input, referrerOrigin }, deps);
    return calls.insertBooking.at(-1);
  };
  {
    const row = await referrerOf("https://partner.example/landing?email=k%40x.com&phone=5551234");
    assert(row?.referrer_origin === "https://partner.example", "create: a referrer with a path and a query is stored as its origin only");
    assert(!JSON.stringify(row).includes("k%40x.com"), "create: the referrer's query reaches no part of the row");
  }
  assert((await referrerOf("not a url"))?.referrer_origin === null, "create: a malformed referrer is dropped, never stored raw");
  assert((await referrerOf(undefined))?.referrer_origin === null, "create: no referrer sent is stored as null");
  assert((await referrerOf("http://localhost:3000"))?.referrer_origin === "http://localhost:3000", "create: a bare origin is stored as itself");

  // --- #2549: the booking stores the first name the lead ANSWERED ---
  // Beside the joined name, so Regal and the greeting it sends read "Mary Jo"
  // rather than splitting "Mary Jo Smith" into "Mary".
  const firstNameOf = async (attendee: typeof input.attendee) => {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    await createBooking({ ...input, attendee }, deps);
    return calls.insertBooking.at(-1);
  };
  {
    const row = await firstNameOf({ ...input.attendee, name: "Mary Jo Smith", firstName: "Mary Jo" });
    assert(row?.attendee_first_name === "Mary Jo", `create: the answered first name is stored (got ${row?.attendee_first_name})`);
    assert(row?.attendee_name === "Mary Jo Smith", "create: beside the joined name, which is unchanged");
  }
  {
    // A caller that sends one name (the direct booking API) stores no first name,
    // never a split presented as an answer (L192).
    const row = await firstNameOf({ ...input.attendee, name: "Mary Jo Smith" });
    assert(row?.attendee_first_name === null, `create: no first name sent stores null (got ${row?.attendee_first_name})`);
  }
  {
    const row = await firstNameOf({ ...input.attendee, name: "Smith Mary", firstName: "Mary" });
    assert(row?.attendee_first_name === null, "create: a first name the joined name does not start with is not stored");
  }

}

await run();
finish();

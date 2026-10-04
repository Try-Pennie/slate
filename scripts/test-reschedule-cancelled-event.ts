// A retried reschedule must never confirm onto a cancelled calendar event (#3217).
//
// The reschedule and reassign event ids are derived from the request (booking,
// ordinal, agent), so a retry after a failure asks Google for the SAME id. Google
// keeps a deleted event's id: an insert with it 409s and the event it then hands
// back is CANCELLED. Before this, the reschedule failure paths deleted their
// pinned event live, and the retry adopted the cancelled one, so the booking read
// as moved while the agent's calendar showed nothing at the new time.
//
// The fake Google here keeps that tombstone. Its insert 409s on any id it has ever
// held and answers through `adoptableEventId`, and it walks the fresh id chain
// through `createWithFreshIdOnTombstone`, the same two the real client uses, so
// whether a reuse is refused and which id comes next is decided by the code under
// test, not the fake.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reschedule-cancelled-event.ts
import {
  rescheduleBooking,
  createBooking,
  reassignBooking,
  processPendingEventDeletions,
  processAbandonedReschedulePins,
  PENDING_DELETION_GIVE_UP_AT,
  type BookingDeps,
  type PendingEventDeletion,
} from "../src/lib/booking/orchestration.ts";
import {
  adoptableEventId,
  createWithFreshIdOnTombstone,
  freshEventId,
  TOMBSTONE_FRESH_IDS,
  EventCancelledOnReuse,
  EventGone,
} from "../src/lib/booking/core.ts";
import type { Booking, User } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, makeBooking, input, bucket, eventType, RR, SYS, NOW } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const TARGET = "2026-06-08T18:00:00.000Z";
/** A is off shift at TARGET, so the move reroutes to B: the reassign branch. */
const OFF_SHIFT_A = new Map([
  ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 810 }] }],
]);

/** Google's side: every id it has ever held, with its status. A deleted event
 *  keeps its id as a cancelled tombstone, which is the whole defect. */
function fakeGoogle() {
  const events = new Map<string, "confirmed" | "cancelled">();
  const liveDeletes: string[] = [];
  let failNextInsertAfterWrite = 0;
  const deps: Partial<BookingDeps> = {
    createEvent: async (_email, _input, clientId, opts) => {
      if (!clientId) throw new Error("these paths always supply an id");
      return createWithFreshIdOnTombstone(
        clientId,
        async (id) => {
          const status = events.get(id);
          if (status) return adoptableEventId(id, { id, status });
          events.set(id, "confirmed");
          if (failNextInsertAfterWrite > 0) {
            failNextInsertAfterWrite--;
            // The insert landed on Google and the answer never came back.
            throw new Error("DeadlineExceededError: google did not answer within 8000ms");
          }
          return id;
        },
        opts?.onFreshId,
      );
    },
    deleteEvent: async (_email, id) => {
      liveDeletes.push(id);
      if (events.has(id)) events.set(id, "cancelled");
    },
  };
  return {
    deps,
    events,
    liveDeletes,
    failOnce: () => {
      failNextInsertAfterWrite = 1;
    },
  };
}

/** The pending_event_deletions table: one row per (calendar, event). */
function queue(google: ReturnType<typeof fakeGoogle>) {
  const rows = new Map<string, PendingEventDeletion>();
  let clock = 0;
  const deps: Partial<BookingDeps> = {
    enqueueEventDeletion: async (email, eventId, bookingId) => {
      if ([...rows.values()].some((r) => r.calendar_email === email && r.gcal_event_id === eventId)) return;
      const id = `q-${rows.size + 1}`;
      rows.set(id, {
        id,
        calendar_email: email,
        gcal_event_id: eventId,
        booking_id: bookingId,
        attempts: 0,
        last_error: null,
        created_at: "2026-06-01T00:00:00.000Z",
        updated_at: String(clock++).padStart(6, "0"),
      });
    },
    loadPendingEventDeletions: async (limit) =>
      [...rows.values()]
        .filter((r) => r.attempts < PENDING_DELETION_GIVE_UP_AT)
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
        .slice(0, limit)
        .map((r) => ({ ...r })),
    removePendingEventDeletion: async (id) => {
      rows.delete(id);
    },
    bumpPendingEventDeletion: async (id, attempts, error) => {
      const r = rows.get(id);
      if (!r) throw new Error(`bump on a row the table does not hold: ${id}`);
      r.attempts = attempts;
      r.last_error = error;
      r.updated_at = String(clock++).padStart(6, "0");
    },
    // The drain's own delete goes through the same fake Google.
    deleteEvent: google.deps.deleteEvent,
  };
  return { deps, rows };
}

/** The live holder question, answered from the booking row the fakes mutate. */
function holderOf(booking: Booking): BookingDeps["liveBookingHoldingEvent"] {
  return async (eventId, statuses) =>
    booking.gcal_event_id === eventId && statuses.includes(booking.status) ? booking.id : null;
}

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  return null;
}

function rescheduleWorld() {
  const ctx = { booking: makeBooking({ gcal_event_id: "gcal-old" }), bucket, eventType };
  const google = fakeGoogle();
  google.events.set("gcal-old", "confirmed");
  const q = queue(google);
  const { deps, calls } = makeDeps({
    existing: ctx,
    bookingById: ctx,
    candidates: ["b"],
    freeEmails: new Set(["a@x.com", "b@x.com"]),
    workingHoursByUser: OFF_SHIFT_A,
  });
  const d: BookingDeps = {
    ...deps,
    ...google.deps,
    ...q.deps,
    liveBookingHoldingEvent: holderOf(ctx.booking),
    // Whatever reschedule lock is still standing pins its event, as the real
    // reschedule_locks read does.
    pendingWritePinsEvent: async (eventId) => (await deps.readReschedulePin(ctx.booking.id))?.gcal_client_id === eventId,
  };
  return { ctx, google, q, d, calls };
}

async function run() {
  // --- 1. the race end to end: a reroute fails after Google wrote its event, the
  // lead retries, and the confirmed booking's event survives the drain ----------
  {
    const { ctx, google, q, d } = rescheduleWorld();
    google.failOnce();
    const err = await caught(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(err instanceof Error, "race: the first attempt fails and the lead is told");
    const written = [...google.events.keys()].find((id) => id !== "gcal-old")!;
    assert(Boolean(written), "race: the failed attempt DID write its event on Google (the precondition)");
    assert(
      !google.liveDeletes.includes(written) && google.events.get(written) === "confirmed",
      "race: the failure does NOT delete its event live, so a retry can still adopt it",
    );
    assert(
      [...q.rows.values()].some((r) => r.gcal_event_id === written),
      "race: the failure queues the event's deletion instead, for the drain to judge",
    );

    const retried = await rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW);
    assert(
      retried.booking.starts_at === TARGET && ctx.booking.gcal_event_id === written,
      "race: the retry moves the booking and adopts the event the failed attempt wrote",
    );
    assert(google.events.get(written) === "confirmed", "race: the adopted event is live on Google, not cancelled");

    const lane = await processPendingEventDeletions(d, 50);
    assert(!google.liveDeletes.includes(written), "race: the drain does NOT delete the event the moved booking holds");
    assert(google.events.get(written) === "confirmed", "race: after the drain the booking's event is still confirmed");
    assert(
      lane.held === 1 && lane.deleted === 0 && ![...q.rows.values()].some((r) => r.gcal_event_id === written),
      "race: the obsolete row is dropped and counted held",
    );
  }

  // --- 2. control (L159): the same failure with NO retry, so nothing ever adopts
  // the event. The drain must delete it, or the hold above proves nothing --------
  {
    const { google, d } = rescheduleWorld();
    google.failOnce();
    await caught(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    const written = [...google.events.keys()].find((id) => id !== "gcal-old")!;
    const lane = await processPendingEventDeletions(d, 50);
    assert(
      lane.deleted === 1 && google.events.get(written) === "cancelled",
      "control: an abandoned reschedule's event, held by nobody, is deleted by the drain",
    );
    assert(google.events.get("gcal-old") === "confirmed", "control: the booking's own old event is untouched");
  }

  // --- 3. the drain HOLDS while a reschedule lock still pins the event, since the
  // resume that adopts it has not happened yet ----------------------------------
  {
    const { ctx, google, q, d } = rescheduleWorld();
    google.failOnce();
    // The release is lost (the process died with the lock standing), so the pin
    // outlives the failed attempt.
    d.releaseReschedule = async () => {};
    await caught(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    const written = [...google.events.keys()].find((id) => id !== "gcal-old")!;
    assert(
      (await d.readReschedulePin(ctx.booking.id))?.gcal_client_id === written,
      "hold: the standing lock pins the written event (the precondition)",
    );
    const lane = await processPendingEventDeletions(d, 50);
    const row = [...q.rows.values()].find((r) => r.gcal_event_id === written);
    assert(
      lane.held === 1 && lane.deleted === 0 && google.events.get(written) === "confirmed",
      "hold: a pinned event is not deleted while the reschedule may still resume",
    );
    assert(row !== undefined && row.attempts === 0, "hold: the row is kept for a later pass, attempts unchanged");
  }

  // --- 4. defence in depth: Google already holds the pinned id as a TOMBSTONE (an
  // older build, or a drain that ran before the retry). The move must land on a
  // fresh, live event rather than adopt the cancelled one ------------------------
  {
    const { ctx, google, d, calls } = rescheduleWorld();
    // Find the id the reroute will pin by letting one attempt write it, then
    // delete it on Google as the drain would.
    google.failOnce();
    d.enqueueEventDeletion = async () => {};
    await caught(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    const tombstoned = [...google.events.keys()].find((id) => id !== "gcal-old")!;
    google.events.set(tombstoned, "cancelled");

    const pinsWritten: string[] = [];
    const writePin = d.writeReschedulePin;
    d.writeReschedulePin = async (bookingId, pin) => {
      pinsWritten.push(pin.gcal_client_id);
      await writePin(bookingId, pin);
    };
    const res = await rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW);
    const landed = ctx.booking.gcal_event_id!;
    assert(res.booking.starts_at === TARGET, "tombstone: the move still succeeds");
    assert(
      landed === freshEventId(tombstoned, 1),
      "tombstone: the booking does NOT adopt the cancelled event; it lands on the next id in the chain",
    );
    assert(google.events.get(landed) === "confirmed", "tombstone: the event the booking holds is live on Google");
    assert(
      pinsWritten.includes(landed) &&
        pinsWritten.indexOf(landed) > pinsWritten.indexOf(tombstoned),
      "tombstone: the fresh id is PINNED before it is created, so a crash resumes onto it",
    );
    const commit = calls.commitReschedule.at(-1)!;
    assert(
      commit.patch.gcal_event_id === landed && commit.patch.reschedule_seq === 1,
      "tombstone: the commit records the live event and advances the ordinal, so the next move derives a new id",
    );
  }

  // --- 5. a commit that loses to a concurrent change queues its rollback rather
  // than deleting live, and the drain still removes an event nobody holds --------
  {
    const { ctx, google, q, d } = rescheduleWorld();
    d.commitReschedule = async () => {
      // A concurrent cancel lands between the create and the commit.
      ctx.booking.status = "cancelled";
      return false;
    };
    const err = await caught(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(err instanceof Error && err.name === "RescheduleConflictError", "conflict: the lost commit is reported");
    const written = [...google.events.keys()].find((id) => id !== "gcal-old")!;
    assert(
      !google.liveDeletes.includes(written) && [...q.rows.values()].some((r) => r.gcal_event_id === written),
      "conflict: the rollback is QUEUED, not deleted live",
    );
    const lane = await processPendingEventDeletions(d, 50);
    assert(
      lane.deleted === 1 && google.events.get(written) === "cancelled",
      "conflict: with nobody holding it, the drain deletes the rolled back event",
    );
  }

  // --- 6. the standalone reassign: a swap that fails after the create queues the
  // event, and the retry (same ordinal, same id) adopts it live -----------------
  {
    const ctx = { booking: makeBooking({ gcal_event_id: "gcal-old" }), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const google = fakeGoogle();
    google.events.set("gcal-old", "confirmed");
    const q = queue(google);
    const { deps } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    let swaps = 0;
    const d: BookingDeps = {
      ...deps,
      ...google.deps,
      ...q.deps,
      liveBookingHoldingEvent: holderOf(ctx.booking),
      pendingWritePinsEvent: async () => false,
      reassignSwap: async (args) => {
        if (++swaps === 1) throw new Error("rpc down");
        return deps.reassignSwap(args);
      },
    };
    const err = await caught(() => reassignBooking("bk1", "b@x.com", SYS, d));
    assert(err instanceof Error, "reassign: the failed swap reaches the caller");
    const written = [...google.events.keys()].find((id) => id !== "gcal-old")!;
    assert(
      !google.liveDeletes.includes(written) && [...q.rows.values()].some((r) => r.gcal_event_id === written),
      "reassign: the failed swap QUEUES its event rather than deleting it live",
    );
    await reassignBooking("bk1", "b@x.com", SYS, d);
    assert(
      ctx.booking.gcal_event_id === written && google.events.get(written) === "confirmed",
      "reassign: the retry adopts the same event, live on Google",
    );
    await processPendingEventDeletions(d, 50);
    assert(google.events.get(written) === "confirmed", "reassign: the drain leaves the adopted event alone");
  }

  // --- reassign world shared by 7 to 9: agents A and B, a fake Google with
  // tombstones, the queue, and a reassign_intents table the drain can see -------
  const reassignWorld = () => {
    const ctx = { booking: makeBooking({ gcal_event_id: "gcal-old" }), bucket, eventType };
    const agents: Record<string, User> = {
      "a@x.com": { id: "a", name: "Agent A", email: "a@x.com", bookable: true } as unknown as User,
      "b@x.com": { id: "b", name: "Agent B", email: "b@x.com", bookable: true } as unknown as User,
    };
    const google = fakeGoogle();
    google.events.set("gcal-old", "confirmed");
    const q = queue(google);
    const intents = new Set<string>();
    const intentWrites: string[] = [];
    const { deps } = makeDeps({ bookingById: ctx });
    const d: BookingDeps = {
      ...deps,
      ...google.deps,
      ...q.deps,
      getAgentByEmail: async (email) => agents[email] ?? null,
      liveBookingHoldingEvent: holderOf(ctx.booking),
      writeReassignIntent: async ({ gcalClientId }) => {
        intentWrites.push(gcalClientId);
        intents.add(gcalClientId);
      },
      deleteReassignIntent: async (_bookingId, gcalClientId) => {
        intents.delete(gcalClientId);
      },
      pendingWritePinsEvent: async (eventId) => intents.has(eventId),
    };
    return { ctx, google, q, d, intents, intentWrites };
  };

  // --- 7. B, then A, then B: a reassign back to an advisor the booking already
  // left must land on a LIVE event on their calendar, never a tombstone ---------
  {
    const { ctx, google, d } = reassignWorld();
    await reassignBooking("bk1", "b@x.com", SYS, d);
    const firstB = ctx.booking.gcal_event_id!;
    await reassignBooking("bk1", "a@x.com", SYS, d);
    assert(google.events.get(firstB) === "cancelled", "B A B: B's first event was deleted by the move to A (the precondition)");
    const err = await caught(() => reassignBooking("bk1", "b@x.com", SYS, d));
    assert(err === null, "B A B: the move back to B succeeds");
    assert(ctx.booking.assigned_user_id === "b", "B A B: the booking is on B again");
    assert(
      google.events.get(ctx.booking.gcal_event_id!) === "confirmed",
      "B A B: the event the booking holds is live on Google",
    );
  }

  // --- 8. a reassign whose derived id is ALREADY a tombstone derives a fresh id,
  // records the intent for it BEFORE the create, and lands on a live event -------
  {
    const { ctx, google, d, intentWrites } = reassignWorld();
    // Learn the id the reassign derives by letting a swap fail once, then delete
    // that event on Google the way a drain would.
    const swap = d.reassignSwap;
    let failSwap = true;
    d.reassignSwap = async (args) => {
      if (failSwap) {
        failSwap = false;
        throw new Error("rpc down");
      }
      return swap(args);
    };
    await caught(() => reassignBooking("bk1", "b@x.com", SYS, d));
    const tombstoned = intentWrites[0];
    google.events.set(tombstoned, "cancelled");
    const err = await caught(() => reassignBooking("bk1", "b@x.com", SYS, d));
    const landed = ctx.booking.gcal_event_id!;
    assert(err === null, "reassign tombstone: the retry succeeds");
    assert(
      landed !== tombstoned && google.events.get(landed) === "confirmed",
      "reassign tombstone: the booking lands on a fresh, live event",
    );
    assert(
      intentWrites.includes(landed) && intentWrites.lastIndexOf(landed) > intentWrites.indexOf(tombstoned),
      "reassign tombstone: the fresh id's intent is written before it is created",
    );
  }

  // --- 9. a failed swap KEEPS its intent standing, so a drain pass that runs
  // before the retry holds the event rather than deleting it --------------------
  {
    const { ctx, google, q, d, intents } = reassignWorld();
    const swap = d.reassignSwap;
    let failSwap = true;
    d.reassignSwap = async (args) => {
      if (failSwap) {
        failSwap = false;
        throw new Error("rpc down");
      }
      return swap(args);
    };
    await caught(() => reassignBooking("bk1", "b@x.com", SYS, d));
    const written = [...google.events.keys()].find((id) => id !== "gcal-old")!;
    assert(intents.has(written), "swap hold: the failed swap leaves its intent standing");
    const lane = await processPendingEventDeletions(d, 50);
    assert(
      lane.held === 1 && lane.deleted === 0 && google.events.get(written) === "confirmed",
      "swap hold: the drain holds the event while the intent pins it",
    );
    await reassignBooking("bk1", "b@x.com", SYS, d);
    assert(
      ctx.booking.gcal_event_id === written && google.events.get(written) === "confirmed" && !intents.has(written),
      "swap hold: the retry adopts the event live and then clears its intent",
    );
    await processPendingEventDeletions(d, 50);
    assert(
      google.events.get(written) === "confirmed" && q.rows.size === 0,
      "swap hold: once the booking holds it the drain drops the row and leaves the event",
    );
  }

  // --- 10. the fresh pin cannot be written: the reschedule still fails loudly AND
  // queues the event it last asked Google for, so nothing is left unaccounted ----
  {
    const { google, q, d } = rescheduleWorld();
    google.failOnce();
    d.enqueueEventDeletion = async () => {};
    await caught(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    const tombstoned = [...google.events.keys()].find((id) => id !== "gcal-old")!;
    google.events.set(tombstoned, "cancelled");
    d.enqueueEventDeletion = q.deps.enqueueEventDeletion!;
    const writePin = d.writeReschedulePin;
    let pinWrites = 0;
    d.writeReschedulePin = async (bookingId, pin) => {
      // The first pin lands; the fresh one after the tombstone is refused.
      if (++pinWrites > 1) throw new Error("reschedule pin could not be written: supabase 503");
      await writePin(bookingId, pin);
    };
    const err = await caught(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(
      err instanceof Error && /pin could not be written/.test(err.message),
      "pin refused: the reschedule fails with the pin write's own error",
    );
    assert(
      [...q.rows.values()].some((r) => r.gcal_event_id === tombstoned),
      "pin refused: the event it asked Google for is still queued for the drain",
    );
  }

  // --- 12 and 13: the IN PLACE branch. A's own event was deleted on Google, so
  // the PATCH meets EventGone and the move recreates the event (#617). That event
  // is this reschedule's own, so it gets the same queue and hold ---------------
  const inPlaceWorld = () => {
    const ctx = { booking: makeBooking({ gcal_event_id: "gcal-old" }), bucket, eventType };
    const google = fakeGoogle();
    google.events.set("gcal-old", "cancelled"); // the advisor deleted it
    const q = queue(google);
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      freeEmails: new Set(["a@x.com"]),
    });
    const d: BookingDeps = {
      ...deps,
      ...google.deps,
      ...q.deps,
      updateEventTime: async (_email, id) => {
        if (google.events.get(id) !== "confirmed") throw new EventGone("events.patch");
      },
      liveBookingHoldingEvent: holderOf(ctx.booking),
      pendingWritePinsEvent: async (eventId) =>
        (await deps.readReschedulePin(ctx.booking.id))?.gcal_client_id === eventId,
    };
    return { ctx, google, q, d, calls };
  };
  const IN_PLACE_TARGET = "2026-06-09T14:00:00.000Z";
  {
    const { ctx, google, q, d } = inPlaceWorld();
    google.failOnce();
    const err = await caught(() => rescheduleBooking("tok1", IN_PLACE_TARGET, RR, "customer", d, NOW));
    assert(err instanceof Error, "in place: the recreate that lost its answer fails the move");
    const written = [...google.events.keys()].find((id) => id !== "gcal-old")!;
    assert(
      Boolean(written) && google.events.get(written) === "confirmed" && !google.liveDeletes.includes(written),
      "in place: the recreated event is NOT deleted live",
    );
    assert(
      [...q.rows.values()].some((r) => r.gcal_event_id === written),
      "in place: its deletion is queued for the drain instead",
    );
    await rescheduleBooking("tok1", IN_PLACE_TARGET, RR, "customer", d, NOW);
    assert(
      ctx.booking.gcal_event_id === written && google.events.get(written) === "confirmed",
      "in place: the retry adopts the recreated event, live on Google",
    );
    await processPendingEventDeletions(d, 50);
    assert(google.events.get(written) === "confirmed", "in place: the drain leaves the adopted event alone");
  }
  {
    const { ctx, google, q, d } = inPlaceWorld();
    d.commitReschedule = async () => {
      ctx.booking.status = "cancelled";
      return false;
    };
    const err = await caught(() => rescheduleBooking("tok1", IN_PLACE_TARGET, RR, "customer", d, NOW));
    assert(err instanceof Error && err.name === "RescheduleConflictError", "in place conflict: the lost commit is reported");
    const written = [...google.events.keys()].find((id) => id !== "gcal-old")!;
    assert(
      !google.liveDeletes.includes(written) && [...q.rows.values()].some((r) => r.gcal_event_id === written),
      "in place conflict: the recreated event is rolled back through the queue, not live",
    );
    const lane = await processPendingEventDeletions(d, 50);
    assert(
      lane.deleted === 1 && google.events.get(written) === "cancelled",
      "in place conflict: with nobody holding it, the drain deletes it",
    );
  }

  // --- 14. the CREATE path: the reservation's id is already a tombstone on Google
  // (an earlier attempt's event the drain deleted). The booking still confirms,
  // on a live event, rather than failing on every retry --------------------------
  {
    const google = fakeGoogle();
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const d: BookingDeps = {
      ...deps,
      ...google.deps,
      createEvent: async (email, args, clientId, opts) => {
        if (clientId && !google.events.has(clientId)) google.events.set(clientId, "cancelled");
        return google.deps.createEvent!(email, args, clientId, opts);
      },
    };
    const res = await createBooking(input, d);
    assert(
      google.events.get(res.booking.gcal_event_id!) === "confirmed",
      "create: a booking whose reserved id is a tombstone confirms on a live event",
    );
  }

  // --- 15. a reassign whose fresh id hook fails part way (the old intent's delete
  // is refused) leaves NO intent behind for an event that was never created ------
  {
    const { d, google, intents, intentWrites } = reassignWorld();
    const swap = d.reassignSwap;
    let failSwap = true;
    d.reassignSwap = async (args) => {
      if (failSwap) {
        failSwap = false;
        throw new Error("rpc down");
      }
      return swap(args);
    };
    await caught(() => reassignBooking("bk1", "b@x.com", SYS, d));
    const base = intentWrites[0];
    google.events.set(base, "cancelled");
    for (let n = 1; n <= TOMBSTONE_FRESH_IDS; n++) google.events.set(freshEventId(base, n), "cancelled");
    const del = d.deleteReassignIntent;
    let refused = false;
    d.deleteReassignIntent = async (bookingId, id) => {
      if (!refused && id === base) {
        refused = true;
        throw new Error("reassign_intents delete: supabase 503");
      }
      await del(bookingId, id);
    };
    const err = await caught(() => reassignBooking("bk1", "b@x.com", SYS, d));
    assert(
      err instanceof Error &&
        !(err instanceof EventCancelledOnReuse) &&
        err.message === "reassign_intents delete: supabase 503",
      "hook refused: the reassign fails with the refused delete's own error, not a tombstone refusal",
    );
    assert(intents.size === 0, "hook refused: both the tombstone's intent and the fresh one are cleared");
  }

  // --- 16. the abandoned pin sweep: an IN PLACE pin that names a recreated event
  // (not the booking's own) owns that event, so the sweep queues it -------------
  {
    const { deps, calls } = makeDeps({
      abandonedPins: [
        // crashed between the recreate and the commit: the pin names the recreated event
        { booking_id: "bk1", pinned_agent_email: "a@x.com", gcal_client_id: "slaterecreated", branch: "in_place", booking_gcal_event_id: "gcal-old", target_starts_at: TARGET, booking_starts_at: "2026-06-08T13:00:00.000Z" },
        // control: an ordinary in place pin names the booking's own event
        { booking_id: "bk2", pinned_agent_email: "a@x.com", gcal_client_id: "gcal-own", branch: "in_place", booking_gcal_event_id: "gcal-own", target_starts_at: TARGET, booking_starts_at: "2026-06-08T13:00:00.000Z" },
        // control: the booking read came back empty, so nothing says the event is not its own
        { booking_id: "bk3", pinned_agent_email: "a@x.com", gcal_client_id: "gcal-unknown", branch: "in_place", booking_gcal_event_id: null, target_starts_at: TARGET, booking_starts_at: null },
      ],
    });
    const res = await processAbandonedReschedulePins(deps, 0);
    assert(
      calls.enqueueEventDeletion.length === 1 && calls.enqueueEventDeletion[0].eventId === "slaterecreated",
      "sweep: an abandoned in place pin's RECREATED event is queued, and only that one",
    );
    assert(res.enqueued === 1 && res.swept === 3, "sweep: it is counted as enqueued");
  }

  // --- 11. every id in the chain is a tombstone: the reassign fails loudly and
  // leaves NO intent standing, since no event was created for the drain to hold --
  {
    const { d, google, intents, intentWrites } = reassignWorld();
    const swap = d.reassignSwap;
    let failSwap = true;
    d.reassignSwap = async (args) => {
      if (failSwap) {
        failSwap = false;
        throw new Error("rpc down");
      }
      return swap(args);
    };
    await caught(() => reassignBooking("bk1", "b@x.com", SYS, d));
    const base = intentWrites[0];
    google.events.set(base, "cancelled");
    for (let n = 1; n <= TOMBSTONE_FRESH_IDS; n++) google.events.set(freshEventId(base, n), "cancelled");
    const err = await caught(() => reassignBooking("bk1", "b@x.com", SYS, d));
    assert(err instanceof EventCancelledOnReuse, "exhausted: the reassign fails with the typed error");
    assert(intents.size === 0, "exhausted: no intent is left standing for an event that was never created");
  }

  finish();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

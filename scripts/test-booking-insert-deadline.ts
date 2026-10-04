// A booking that runs out of its confirm budget at the insert (#3215).
//
// Production, 2026-10-04: the insert was refused at 0ms because the 12 second
// confirm budget was spent. Three things went wrong at once, and each is pinned
// here against the real orchestration with the shared fake:
//
//  1. The deadline reached the route as a plain `Error("Failed to persist
//     booking")`, so `timeoutAsRetryable` could not see it and the lead got a
//     generic 500 instead of the retryable "try again in a moment".
//  2. The compensation for the Google event already written ran under the SAME
//     spent budget, so every call it made was refused at once.
//  3. The event id is derived from the request, so the lead's retry adopted the
//     same event. Had the compensation landed, the deletion lane would later have
//     removed the event belonging to the confirmed booking (L744).
//
// The budget is the real `call-budget.ts` one, opened already spent, and the
// fake's calendar and queue writes ask it for their deadline exactly as the
// real Supabase and Google clients do. So "ran under the cleanup allowance" is
// measured by the write succeeding, not by trusting a wrapper was called.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-insert-deadline.ts
import {
  createBooking,
  rescheduleBooking,
  deleteEventBestEffort,
  processPendingEventDeletions,
  checkCreationOrphans,
  timeoutAsRetryable,
  DependencyTimeoutError,
  SlotUnavailableError,
  type BookingDeps,
  type PendingEventDeletion,
} from "../src/lib/booking/orchestration.ts";
import type { Booking, BookingStatus } from "../src/lib/db/types.ts";
import { deadlineWithinBudget, withinCallBudget } from "../src/lib/call-budget.ts";
import { createAsserter, makeDeps, makeBooking, input, bucket, eventType, RR, NOW } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/** What a PostgREST result carries when its fetch hit the confirm deadline: the
 *  fetch failure folded into `message` as `<name>: <message>`. */
const deadlineResult = () => ({
  message:
    "DeadlineExceededError: supabase did not answer within 0ms, when the booking confirm ran out of its 12000ms",
  details: "",
  hint: "",
  code: "",
});

/** Run `work` inside a confirm budget that is ALREADY spent, as the 15:05:12
 *  request was by the time it reached the insert. */
function underSpentConfirmBudget<T>(work: () => Promise<T>): Promise<T> {
  return withinCallBudget(12_000, "the booking confirm", work, () => Date.now() - 13_000);
}

/** A dependency call as the real clients make one: refused at once when the
 *  budget it runs under is spent. */
function budgeted(label: string): void {
  deadlineWithinBudget(4_000, label);
}

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  return null;
}

function queueRow(id: string, eventId: string, bookingId: string | null = null): PendingEventDeletion {
  return {
    id,
    calendar_email: "a@x.com",
    gcal_event_id: eventId,
    booking_id: bookingId,
    attempts: 0,
    last_error: null,
    created_at: "2026-10-04T15:05:12.000Z",
    updated_at: "2026-10-04T15:05:12.000Z",
  };
}

async function run() {
  // --- 1. a deadline at the insert reaches the route as the retryable outage ---
  {
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const d: BookingDeps = { ...deps, insertBooking: async () => ({ ok: false, conflict: false, error: deadlineResult() }) };
    const err = await caught(() => createBooking(input, d));
    assert(err instanceof Error, "insert deadline: the create throws");
    const answered = timeoutAsRetryable(err);
    assert(
      answered instanceof DependencyTimeoutError,
      "insert deadline: timeoutAsRetryable answers it as the retryable DependencyTimeoutError, not a generic 500",
    );
    assert(
      answered instanceof DependencyTimeoutError && answered.dependency === "supabase",
      "insert deadline: the outage names the dependency that did not answer",
    );
  }
  // Control: an insert failure that is NOT a deadline stays an unexpected error,
  // so the classification above is not every failure becoming a 503.
  {
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const d: BookingDeps = {
      ...deps,
      insertBooking: async () => ({ ok: false, conflict: false, error: { message: "null value in column org_id" } }),
    };
    const err = await caught(() => createBooking(input, d));
    assert(
      err instanceof Error && timeoutAsRetryable(err) === err,
      "insert failure that is not a deadline: left as the unexpected error it is",
    );
  }

  // --- 2. the compensation runs under the cleanup allowance ---------------------
  // A generic failure leaves the reservation PENDING (the resume, or the lead's
  // retry, adopts the same event id), so the event is not deleted live: that
  // would hand the retry a cancelled event. Its deletion is queued instead, and
  // the queue write must land even though the confirm budget is spent.
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const queued: { eventId: string; bookingId: string | null }[] = [];
    const d: BookingDeps = {
      ...deps,
      insertBooking: async () => ({ ok: false, conflict: false, error: deadlineResult() }),
      enqueueEventDeletion: async (_email, eventId, bookingId) => {
        budgeted("supabase");
        queued.push({ eventId, bookingId });
      },
      deleteEvent: async (email, id, opts) => {
        budgeted("google");
        await deps.deleteEvent(email, id, opts);
      },
    };
    await caught(() => underSpentConfirmBudget(() => createBooking(input, d)));
    assert(
      queued.length === 1 && queued[0].eventId === "gcal-1" && queued[0].bookingId === null,
      "spent budget, generic failure: the event's deletion is queued under the cleanup allowance",
    );
    assert(
      calls.deleteEvent.length === 0,
      "generic failure: the event the pending reservation still pins is not deleted live",
    );
  }
  // A conflict deletes the reservation (the slot is gone), so the event is
  // deleted live, and that delete must not be refused by the spent budget.
  {
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      insertBookingConflict: true,
    });
    const d: BookingDeps = {
      ...deps,
      deleteEvent: async (email, id, opts) => {
        budgeted("google");
        await deps.deleteEvent(email, id, opts);
      },
      enqueueEventDeletion: async (email, eventId, bookingId) => {
        budgeted("supabase");
        await deps.enqueueEventDeletion(email, eventId, bookingId);
      },
    };
    const err = await caught(() => underSpentConfirmBudget(() => createBooking(input, d)));
    assert(err instanceof SlotUnavailableError, "spent budget, conflict: still refused as slot unavailable");
    assert(
      calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-1",
      "spent budget, conflict: the rollback delete runs under the cleanup allowance and lands",
    );
  }

  // --- 3. the race: the failed attempt queues a deletion, the retry adopts the
  // event, and the lane must NOT delete it -------------------------------------
  {
    const bookings: Booking[] = [];
    const queue: PendingEventDeletion[] = [];
    const deleted: string[] = [];
    let attempt = 0;
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const d: BookingDeps = {
      ...deps,
      insertBooking: async (row) => {
        attempt++;
        if (attempt === 1) return { ok: false, conflict: false, error: deadlineResult() };
        const booking = { ...row, id: "bk-retry" } as unknown as Booking;
        bookings.push(booking);
        return { ok: true, booking };
      },
      enqueueEventDeletion: async (email, eventId, bookingId) => {
        queue.push({ ...queueRow(`q-${queue.length + 1}`, eventId, bookingId), calendar_email: email });
      },
      loadPendingEventDeletions: async () => [...queue],
      removePendingEventDeletion: async (id) => {
        const i = queue.findIndex((r) => r.id === id);
        if (i >= 0) queue.splice(i, 1);
      },
      deleteEvent: async (_email, id) => {
        deleted.push(id);
      },
      loadBookingsHoldingEvent: async (eventId) =>
        bookings.filter((b) => b.gcal_event_id === eventId).map((b) => ({ id: b.id, status: b.status })),
      // The retry completed the reservation, so nothing pins the event any more.
      reservationPinsEvent: async () => false,
    };
    await caught(() => underSpentConfirmBudget(() => createBooking(input, d)));
    assert(queue.length === 1 && queue[0].gcal_event_id === "gcal-1", "race: the failed attempt queued its event");
    const retried = await createBooking(input, d);
    assert(
      retried.booking.gcal_event_id === "gcal-1",
      "race: the retry adopted the same event id (the precondition the lane must respect)",
    );
    const lane = await processPendingEventDeletions(d, 50);
    assert(!deleted.includes("gcal-1"), "race: the lane does NOT delete the event the confirmed booking holds");
    assert(queue.length === 0, "race: the lane drops the row a live booking made obsolete");
    assert(lane.held === 1 && lane.deleted === 0 && lane.failed === 0, "race: the dropped row is counted as held");
  }
  // Control (L159): the same queue with NO booking holding the event is deleted,
  // so the refusal above is the holder check and not a lane that deletes nothing.
  {
    const deleted: string[] = [];
    const queue = [queueRow("q-1", "gcal-1")];
    const { deps } = makeDeps({});
    const d: BookingDeps = {
      ...deps,
      loadPendingEventDeletions: async () => [...queue],
      removePendingEventDeletion: async (id) => {
        queue.splice(queue.findIndex((r) => r.id === id), 1);
      },
      deleteEvent: async (_email, id) => {
        deleted.push(id);
      },
      loadBookingsHoldingEvent: async () => [{ id: "bk-gone", status: "cancelled" as BookingStatus }],
      reservationPinsEvent: async () => false,
    };
    const lane = await processPendingEventDeletions(d, 50);
    assert(
      deleted.includes("gcal-1") && lane.deleted === 1 && queue.length === 0,
      "control: an event only a CANCELLED booking names is deleted",
    );
  }
  // A pending reservation still pins the event: a resume may adopt it, so the
  // lane leaves the row for a later pass rather than deleting under it.
  {
    const deleted: string[] = [];
    const bumps: string[] = [];
    const queue = [queueRow("q-1", "gcal-1")];
    const { deps } = makeDeps({});
    const d: BookingDeps = {
      ...deps,
      loadPendingEventDeletions: async () => [...queue],
      deleteEvent: async (_email, id) => {
        deleted.push(id);
      },
      bumpPendingEventDeletion: async (id) => {
        bumps.push(id);
      },
      loadBookingsHoldingEvent: async () => [],
      reservationPinsEvent: async () => true,
    };
    const lane = await processPendingEventDeletions(d, 50);
    assert(deleted.length === 0, "pinned: the lane does not delete an event a pending reservation pins");
    assert(queue.length === 1 && bumps.length === 0, "pinned: the row is left untouched for a later pass");
    assert(lane.held === 1, "pinned: counted as held, so saturation still sees the page it loaded");
  }
  // The holder read failing must not become a delete (fail safe), and must not
  // be classified as a Google refusal either.
  {
    const deleted: string[] = [];
    const bumps: { attempts: number; error: string }[] = [];
    const { deps } = makeDeps({});
    const d: BookingDeps = {
      ...deps,
      loadPendingEventDeletions: async () => [queueRow("q-1", "gcal-1")],
      deleteEvent: async (_email, id) => {
        deleted.push(id);
      },
      bumpPendingEventDeletion: async (_id, attempts, error) => {
        bumps.push({ attempts, error });
      },
      loadBookingsHoldingEvent: async () => {
        throw new Error("bookings read timed out");
      },
      reservationPinsEvent: async () => false,
    };
    const lane = await processPendingEventDeletions(d, 50);
    assert(deleted.length === 0, "holder unreadable: nothing is deleted");
    assert(
      lane.failed === 1 && lane.refused.length === 0 && bumps.length === 1 && bumps[0].attempts === 1,
      "holder unreadable: a transient failure, retried next pass, never ended as refused",
    );
  }

  // --- the enqueue skips an event a live booking already holds -------------------
  {
    const queued: string[] = [];
    const { deps } = makeDeps({ deleteEventThrows: true });
    const d: BookingDeps = {
      ...deps,
      enqueueEventDeletion: async (_email, eventId) => {
        queued.push(eventId);
      },
      loadBookingsHoldingEvent: async () => [{ id: "bk-live", status: "confirmed" as BookingStatus }],
    };
    await deleteEventBestEffort(d, "a@x.com", "gcal-1", null);
    assert(queued.length === 0, "enqueue: skipped when a live booking already holds the event");
  }
  {
    const queued: string[] = [];
    const { deps } = makeDeps({ deleteEventThrows: true });
    const d: BookingDeps = {
      ...deps,
      enqueueEventDeletion: async (_email, eventId) => {
        queued.push(eventId);
      },
      loadBookingsHoldingEvent: async () => {
        throw new Error("bookings read timed out");
      },
    };
    await deleteEventBestEffort(d, "a@x.com", "gcal-1", null);
    assert(queued.length === 1, "enqueue: an unreadable holder still queues (the lane checks again)");
  }

  // --- a reschedule that fails with the budget spent still hands its lock back --
  // Otherwise the release is refused at 0ms too, and the lead's retry meets its
  // own reschedule lock until the lease expires.
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const released: string[] = [];
    const d: BookingDeps = {
      ...deps,
      updateEventTime: async () => {
        throw new Error("events.patch failed: 503 backendError");
      },
      releaseReschedule: async (bookingId) => {
        budgeted("supabase");
        released.push(bookingId);
      },
    };
    const err = await caught(() =>
      underSpentConfirmBudget(() => rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", d, NOW)),
    );
    assert(err instanceof Error, "reschedule, spent budget: the failure still reaches the caller");
    assert(released.length === 1 && released[0] === "bk1", "reschedule, spent budget: the lock is released under the cleanup allowance");
  }

  // --- the creation orphan alert does not page about an adopted event ----------
  {
    const { deps } = makeDeps({});
    const d: BookingDeps = {
      ...deps,
      loadCreationOrphans: async () => [queueRow("q-1", "gcal-1"), queueRow("q-2", "gcal-2")],
      eventExists: async () => true,
      loadBookingsHoldingEvent: async (eventId) =>
        eventId === "gcal-1" ? [{ id: "bk-retry", status: "confirmed" as BookingStatus }] : [],
      reservationPinsEvent: async () => false,
    };
    const res = await checkCreationOrphans(d, 10);
    assert(
      res.confirmed.length === 1 && res.confirmed[0].gcal_event_id === "gcal-2",
      "orphan alert: an event a live booking adopted is not an orphan; one nobody holds still is",
    );
  }

  finish();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

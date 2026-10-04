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
  PENDING_DELETION_GIVE_UP_AT,
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

/**
 * The pending_event_deletions table as the real queries treat it: one row per
 * (calendar, event) because the enqueue is an upsert that ignores a duplicate on
 * that unique index, a loader that skips given up rows and takes the LEAST
 * RECENTLY TOUCHED first (`updated_at`, which every bump moves), and a bump that
 * touches the row. The deletes Google was asked for are recorded.
 */
function table(seed: PendingEventDeletion[] = []) {
  let clock = 0;
  const rows = new Map<string, PendingEventDeletion>();
  for (const r of seed) rows.set(r.id, { ...r, updated_at: String(clock++).padStart(6, "0") });
  const deleted: string[] = [];
  const deps: Partial<BookingDeps> = {
    enqueueEventDeletion: async (email, eventId, bookingId) => {
      const dup = [...rows.values()].some((r) => r.calendar_email === email && r.gcal_event_id === eventId);
      if (dup) return;
      const id = `q-${rows.size + 1}`;
      rows.set(id, { ...queueRow(id, eventId, bookingId), calendar_email: email, updated_at: String(clock++).padStart(6, "0") });
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
    deleteEvent: async (_email, id) => {
      deleted.push(id);
    },
  };
  return { rows, deleted, deps };
}

/** The holder question as the real query asks it: a FILTERED existence check over
 *  the statuses it is given, never a page of whatever rows name the event. */
function holderFrom(bookings: Booking[]) {
  return async (eventId: string, statuses: readonly BookingStatus[]): Promise<string | null> =>
    bookings.find((b) => b.gcal_event_id === eventId && statuses.includes(b.status))?.id ?? null;
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
    const t = table();
    let attempt = 0;
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const d: BookingDeps = {
      ...deps,
      ...t.deps,
      insertBooking: async (row) => {
        attempt++;
        if (attempt <= 2) return { ok: false, conflict: false, error: deadlineResult() };
        const booking = { ...row, id: "bk-retry" } as unknown as Booking;
        bookings.push(booking);
        return { ok: true, booking };
      },
      liveBookingHoldingEvent: holderFrom(bookings),
      // The retry completed the reservation, so nothing pins the event any more.
      reservationPinsEvent: async () => false,
    };
    await caught(() => underSpentConfirmBudget(() => createBooking(input, d)));
    await caught(() => underSpentConfirmBudget(() => createBooking(input, d)));
    assert(
      t.rows.size === 1 && [...t.rows.values()][0].gcal_event_id === "gcal-1",
      "race: two failed attempts on one event leave ONE queue row (the enqueue is idempotent per event)",
    );
    const retried = await createBooking(input, d);
    assert(
      retried.booking.gcal_event_id === "gcal-1",
      "race: the retry adopted the same event id (the precondition the lane must respect)",
    );
    const lane = await processPendingEventDeletions(d, 50);
    assert(!t.deleted.includes("gcal-1"), "race: the lane does NOT delete the event the confirmed booking holds");
    assert(t.rows.size === 0, "race: the lane drops the row a live booking made obsolete");
    assert(lane.held === 1 && lane.deleted === 0 && lane.failed === 0, "race: the dropped row is counted as held");
  }
  // Control (L159): the same queue with NO live booking holding the event is
  // deleted, so the refusal above is the holder check and not a lane that deletes
  // nothing. Several CANCELLED bookings name the event, which the holder question
  // must filter out rather than page through.
  {
    const t = table([queueRow("q-1", "gcal-1")]);
    const cancelled = Array.from({ length: 12 }, (_, i) =>
      ({ id: `bk-gone-${i}`, gcal_event_id: "gcal-1", status: "cancelled" }) as unknown as Booking,
    );
    const { deps } = makeDeps({});
    const d: BookingDeps = {
      ...deps,
      ...t.deps,
      liveBookingHoldingEvent: holderFrom(cancelled),
      reservationPinsEvent: async () => false,
    };
    const lane = await processPendingEventDeletions(d, 50);
    assert(
      t.deleted.includes("gcal-1") && lane.deleted === 1 && t.rows.size === 0,
      "control: an event only CANCELLED bookings name is deleted",
    );
  }
  // The holder question asks about EVERY status that keeps a slot busy, and only
  // those, so a live holder behind any number of cancelled rows is still found.
  {
    const t = table([queueRow("q-1", "gcal-1")]);
    const rows = [
      ...Array.from({ length: 12 }, (_, i) =>
        ({ id: `bk-gone-${i}`, gcal_event_id: "gcal-1", status: "cancelled" }) as unknown as Booking,
      ),
      { id: "bk-live", gcal_event_id: "gcal-1", status: "rescheduled" } as unknown as Booking,
    ];
    let askedFor: readonly BookingStatus[] = [];
    const holder = holderFrom(rows);
    const { deps } = makeDeps({});
    const d: BookingDeps = {
      ...deps,
      ...t.deps,
      liveBookingHoldingEvent: (eventId, statuses) => ((askedFor = statuses), holder(eventId, statuses)),
      reservationPinsEvent: async () => false,
    };
    await processPendingEventDeletions(d, 50);
    assert(
      [...askedFor].sort().join(",") === "completed,confirmed,rescheduled",
      "holder: asked for exactly the statuses that keep a slot busy",
    );
    assert(!t.deleted.includes("gcal-1"), "holder: a live booking behind twelve cancelled ones still keeps its event");
  }
  // A pending reservation still pins the event, so a resume may adopt it. The
  // row is kept but rotated to the back of the queue, so held rows can never fill
  // every page and starve a deletable row behind them.
  {
    const pinned = Array.from({ length: 5 }, (_, i) => queueRow(`p-${i}`, `pinned-${i}`));
    const t = table([...pinned, queueRow("free", "gcal-free")]);
    const { deps } = makeDeps({});
    const d: BookingDeps = {
      ...deps,
      ...t.deps,
      liveBookingHoldingEvent: async () => null,
      reservationPinsEvent: async (eventId) => eventId.startsWith("pinned-"),
    };
    const first = await processPendingEventDeletions(d, 5);
    assert(
      first.held === 5 && first.deleted === 0 && t.deleted.length === 0,
      "pinned: a page full of pinned rows deletes nothing",
    );
    assert(
      pinned.every((p) => t.rows.get(p.id)?.attempts === 0),
      "pinned: a held row's attempts are untouched (holding is not failing)",
    );
    const second = await processPendingEventDeletions(d, 5);
    assert(
      t.deleted.includes("gcal-free") && second.deleted === 1,
      "pinned: the next pass reaches the deletable row the held page was in front of",
    );
    assert(t.rows.size === 5, "pinned: every pinned row is still queued for when its reservation ends");
  }
  // The holder read failing must not become a delete (fail safe), and must not
  // be classified as a Google refusal either.
  {
    const t = table([queueRow("q-1", "gcal-1")]);
    const { deps } = makeDeps({});
    const d: BookingDeps = {
      ...deps,
      ...t.deps,
      liveBookingHoldingEvent: async () => {
        throw new Error("bookings read timed out");
      },
      reservationPinsEvent: async () => false,
    };
    const lane = await processPendingEventDeletions(d, 50);
    assert(t.deleted.length === 0, "holder unreadable: nothing is deleted");
    assert(
      lane.failed === 1 && lane.refused.length === 0 && t.rows.get("q-1")?.attempts === 1,
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
      liveBookingHoldingEvent: async () => "bk-live",
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
      liveBookingHoldingEvent: async () => {
        throw new Error("bookings read timed out");
      },
    };
    await deleteEventBestEffort(d, "a@x.com", "gcal-1", null);
    assert(queued.length === 1, "enqueue: an unreadable holder still queues (the lane checks again)");
  }

  // --- a reschedule hands its lock back under the cleanup allowance only when it
  // FAILED. Otherwise a release refused at 0ms leaves the lead's retry meeting its
  // own lock until the lease expires; but a successful reschedule must not open
  // the request's one shared allowance, which a later failure in the route needs.
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
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const rescheduled = {
      booking: { ...ctx.booking, starts_at: "2026-06-09T14:00:00.000Z", ends_at: "2026-06-09T14:30:00.000Z", status: "rescheduled" as const },
      bucket,
      eventType,
    };
    const { deps } = makeDeps({ existing: ctx, bookingById: rescheduled, freeEmails: new Set(["a@x.com"]) });
    const releasedUnder: (string | null)[] = [];
    const d: BookingDeps = {
      ...deps,
      releaseReschedule: async () => {
        // A wait longer than either budget reports which budget cut it short.
        releasedUnder.push(deadlineWithinBudget(60_000, "supabase").reportAs.budget?.label ?? null);
      },
    };
    await withinCallBudget(12_000, "the booking confirm", () =>
      rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", d, NOW),
    );
    assert(
      releasedUnder.length === 1 && releasedUnder[0] === "the booking confirm",
      "reschedule succeeded: the lock is released under the confirm budget, leaving the cleanup allowance unopened",
    );
  }

  // --- the creation orphan alert does not page about an adopted event ----------
  {
    const { deps } = makeDeps({});
    const d: BookingDeps = {
      ...deps,
      loadCreationOrphans: async () => [queueRow("q-1", "gcal-1"), queueRow("q-2", "gcal-2")],
      eventExists: async () => true,
      liveBookingHoldingEvent: async (eventId) => (eventId === "gcal-1" ? "bk-retry" : null),
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

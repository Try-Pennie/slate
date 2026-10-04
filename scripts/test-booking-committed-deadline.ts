// A booking that commits, then runs out of its confirm budget (#3263).
//
// Production, 2026-10-04 21:31 UTC: the booking row was inserted about 9.4s into
// the confirm, then the 12 second budget ran out in the work that follows (the
// stack named resolveBucketByCode), and the route answered a retryable 503 for a
// booking that existed. The lead's retry six seconds later got 200 and the same
// booking. #3215 made a deadline AT the insert retryable; this is the case AFTER
// it, where the only honest answer is the booking.
//
// The budget is the real `call-budget.ts` one. The fake's calls ask it for their
// deadline the way the real Supabase and Google clients do, against a clock this
// file moves forward the moment the insert commits. So "the budget ran out after
// the commit" is a real refusal at 0ms, not a stub that throws.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-committed-deadline.ts
import {
  createBooking,
  processBookingReservations,
  timeoutAsRetryable,
  DependencyTimeoutError,
  type BookingDeps,
} from "../src/lib/booking/orchestration.ts";
import type { BookingReservation } from "../src/lib/db/types.ts";
import { deadlineWithinBudget, withinCallBudget } from "../src/lib/call-budget.ts";
import { DeadlineExceededError } from "../src/lib/fetch-within-deadline.ts";
import { busyBlockWriteThroughAlert } from "../src/lib/booking/alert-copy.ts";
import { shortFailureReason } from "../src/lib/notify/error-text.ts";
import { createAsserter, makeDeps, input } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/**
 * A confirm budget whose clock this test controls. `spend()` moves the clock
 * past the budget's end, so every budgeted call after it is refused at once,
 * exactly as the real clients refuse one once the 12 seconds are gone.
 */
function confirmClock() {
  let skew = 0;
  const now = () => Date.now() + skew;
  return {
    now,
    spend: () => {
      skew = 13_000;
    },
    run: <T>(work: () => Promise<T>) => withinCallBudget(12_000, "the booking confirm", work, now),
    /** A dependency call as the real clients make one. */
    call: (label: string) => {
      deadlineWithinBudget(4_000, label, now);
    },
  };
}

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  return (await settle(work)).err;
}

/** The value, or the error, a call settled with. */
async function settle<T>(work: () => Promise<T>): Promise<{ value: T | null; err: unknown }> {
  try {
    return { value: await work(), err: null };
  } catch (err) {
    return { value: null, err };
  }
}

const said = (err: unknown) => (err === null ? "no error" : err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/**
 * Deps where every Supabase and Google call after the insert asks the budget,
 * and the insert itself spends it on the way out: the commit lands, then the
 * clock is past the 12 seconds.
 */
function committedThenSpent(clock: ReturnType<typeof confirmClock>) {
  const fixture = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
  const { deps } = fixture;
  let reservation: BookingReservation | null = null;
  let committed: Awaited<ReturnType<BookingDeps["insertBooking"]>> | null = null;
  const d: BookingDeps = {
    ...deps,
    insertReservation: async (row) => {
      reservation = await deps.insertReservation(row);
      return reservation;
    },
    insertBooking: async (row) => {
      clock.call("supabase");
      committed = await deps.insertBooking(row);
      clock.spend();
      return committed;
    },
    moveBusyBlock: async (...args) => {
      clock.call("supabase");
      await deps.moveBusyBlock(...args);
    },
    invalidateSlots: async (code) => {
      clock.call("supabase");
      await deps.invalidateSlots(code);
    },
    resolveBucketByCode: async (code) => {
      clock.call("supabase");
      return deps.resolveBucketByCode(code);
    },
    deleteReservation: async (id) => {
      clock.call("supabase");
      await deps.deleteReservation(id);
    },
  };
  return {
    ...fixture,
    d,
    reservation: () => reservation,
    committed: () => committed,
  };
}

async function run() {
  // --- 1. the budget runs out after the commit: the lead gets the booking -----
  {
    const clock = confirmClock();
    const f = committedThenSpent(clock);
    const { value: res, err } = await settle(() => clock.run(() => createBooking(input, f.d)));
    assert(err === null, `committed then spent: the confirm answers success, not an error (got ${said(err)})`);
    const committed = f.committed();
    assert(
      res !== null && committed?.ok === true && res.booking.id === committed.booking.id,
      "committed then spent: the answer carries the booking that was inserted",
    );
    assert(
      res?.newlyInserted === true,
      "committed then spent: it is still this confirm's own insert, so the race tally counts it once",
    );
    assert(f.calls.insertBooking.length === 1, "committed then spent: one insert, nothing written twice");
    assert(
      f.calls.deletedReservations.length === 0,
      "committed then spent: the reservation is LEFT pending, so the drain finishes the side effects the budget cut off",
    );
    assert(
      f.calls.webhooks.length === 0,
      "control: the side effects really were cut off (no booking.created fired inline), so the case is the cut off one",
    );

    // The existing reservation drain finishes it: a later tick, no budget, finds
    // the booking by its key and delivers what the confirm could not.
    if (res !== null && committed?.ok) {
      const reservation = f.reservation();
      const booking = committed.booking;
      const drained = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
      const dd: BookingDeps = {
        ...drained.deps,
        loadDrainableReservations: async () => (reservation ? [reservation] : []),
        findBookingByIdempotencyKey: async () => booking,
      };
      const out = await processBookingReservations(dd, 10);
      assert(
        out.completed === 1 && out.failed === 0,
        "drain: the left reservation completes on the next tick",
      );
      assert(
        drained.calls.moveBusyBlock.length === 1 && drained.calls.moveBusyBlock[0].bookingId === booking.id,
        "drain: the busy block the confirm could not write is written",
      );
      assert(
        drained.calls.webhooks.some((w) => w.event === "booking.created"),
        "drain: booking.created is delivered",
      );
      assert(
        reservation !== null && drained.calls.deletedReservations.includes(reservation.id),
        "drain: and only then is the reservation deleted",
      );
    }
  }

  // --- 2. any failure after the commit answers success, not only a deadline ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const d: BookingDeps = {
      ...deps,
      invalidateSlots: async () => {
        throw new Error("bucket_slots update refused");
      },
    };
    const err = await caught(() => createBooking(input, d));
    assert(err === null, `a non-deadline failure after the commit: still the booking, not a 500 (got ${said(err)})`);
    assert(
      calls.insertBooking.length === 1 && calls.deletedReservations.length === 0,
      "a non-deadline failure after the commit: the reservation stays for the drain",
    );
  }

  // --- 3. the drain itself still counts a failed finish as a failure ----------
  // The request answers success; the drain must NOT, or a reservation whose side
  // effects never land would read as completed every tick, never back off and
  // never reach the stuck alert.
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const clock = confirmClock();
    const f = committedThenSpent(clock);
    const res = await clock.run(() => createBooking(input, f.d));
    const reservation = f.reservation();
    const d: BookingDeps = {
      ...deps,
      loadDrainableReservations: async () => (reservation ? [reservation] : []),
      findBookingByIdempotencyKey: async () => res.booking,
      resolveBucketByCode: async () => {
        throw new Error("buckets read down");
      },
    };
    const out = await processBookingReservations(d, 10);
    assert(
      out.failed === 1 && out.completed === 0,
      "drain: a finish that fails is a failure, not a completion",
    );
    assert(
      calls.reservationBumps.length === 1 && calls.deletedReservations.length === 0,
      "drain: the attempt is bumped (backoff, and the stuck alert past the threshold) and the row is kept",
    );
  }

  // --- 4. a lead's retry that resumes a committed booking answers it too -------
  // The retry finds the reservation in flight and the booking already inserted
  // (the resume branch). Its side effects run again under the retry's own
  // budget, and a budget that runs out there must not refuse the booking either.
  {
    const clock = confirmClock();
    const first = committedThenSpent(clock);
    const made = await clock.run(() => createBooking(input, first.d));
    const reservation = first.reservation();

    const retryClock = confirmClock();
    let lookups = 0;
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      reservation,
    });
    const d: BookingDeps = {
      ...deps,
      // The replay fast path misses (the booking was read a moment before it
      // committed), and the resume's own lookup finds it.
      findBookingByIdempotencyKey: async () => (lookups++ === 0 ? null : made.booking),
      moveBusyBlock: async () => {
        retryClock.spend();
        retryClock.call("supabase");
      },
    };
    const { value: again, err } = await settle(() => retryClock.run(() => createBooking(input, d)));
    assert(err === null, `resume after the commit: the retry answers the booking, not a 503 (got ${said(err)})`);
    assert(again?.booking.id === made.booking.id, "resume after the commit: it is the same booking");
    assert(calls.insertBooking.length === 0, "resume after the commit: nothing inserted a second time");
    assert(calls.deletedReservations.length === 0, "resume after the commit: the reservation stays for the drain");
  }

  // --- 5. controls: a deadline BEFORE or AT the insert is still retryable -----
  // Exactly as #3216 left it. Answering success there would tell a lead they
  // were booked when nothing was written.
  {
    const clock = confirmClock();
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const d: BookingDeps = {
      ...deps,
      insertBooking: async (row) => {
        clock.spend();
        clock.call("supabase");
        return deps.insertBooking(row);
      },
    };
    const err = await caught(() => clock.run(() => createBooking(input, d)));
    const answered = timeoutAsRetryable(err);
    assert(
      answered instanceof DependencyTimeoutError && answered.dependency === "supabase",
      "deadline AT the insert: still the retryable outage naming supabase",
    );
    assert(calls.insertBooking.length === 0, "deadline AT the insert: control, nothing was inserted");
  }
  {
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const d: BookingDeps = {
      ...deps,
      createEvent: async () => {
        throw new DeadlineExceededError("google events.insert", 0, { label: "the booking confirm", totalMs: 12_000 });
      },
    };
    const err = await caught(() => createBooking(input, d));
    assert(
      timeoutAsRetryable(err) instanceof DependencyTimeoutError,
      "deadline BEFORE the insert: still the retryable outage",
    );
  }

  // --- 6. the alert raised after the commit says the booking went through ----
  // The cache write through runs AFTER the booking row committed, so its page
  // must not read as a failed booking, and its reason must say the budget was
  // used up rather than "supabase did not answer within 0ms".
  {
    const reason =
      shortFailureReason(
        "DeadlineExceededError: supabase did not answer within 0ms, when the booking confirm ran out of its 12000ms",
      ) ?? "";
    const move = busyBlockWriteThroughAlert("move", "bk_1", reason);
    const insert = busyBlockWriteThroughAlert("insert", "booking bk_1", reason);
    assert(/went through/.test(move), `write through move: says the booking went through (got: ${move})`);
    assert(/went through/.test(insert), `write through insert: says the booking went through (got: ${insert})`);
    assert(
      move.includes("before Slate asked supabase") && !move.includes("within 0ms"),
      `write through: the reason says the budget was used up first (got: ${move})`,
    );
    const del = busyBlockWriteThroughAlert("delete", "bk_1", "statement timeout");
    assert(!/went through/.test(del), "control: a delete is a cancel's write through and claims nothing about a booking");
  }

  // --- 7. the #586 mirror cleanup keys on the event this create used ---------
  // Not on a re-read of the returned row: a row handed back without the column
  // must not silently skip the cleanup.
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const d: BookingDeps = {
      ...deps,
      insertBooking: async (row) => {
        const res = await deps.insertBooking(row);
        return res.ok ? { ...res, booking: { ...res.booking, gcal_event_id: null } } : res;
      },
    };
    await createBooking(input, d);
    assert(
      calls.deleteGcalMirror.length === 1 && calls.deleteGcalMirror[0].gcalEventId === "gcal-1",
      "mirror cleanup: runs for the event this create wrote, even when the returned row omits it",
    );
  }

  finish();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

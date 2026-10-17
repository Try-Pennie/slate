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
// file moves forward the moment the save commits. So "the budget ran out after
// the commit" is a real refusal at 0ms, not a stub that throws.
//
// #3495: the save is ONE call now (`commit_fresh_booking`), so the busy block, the
// webhook and the reservation's delete are inside the commit, not after it. What a
// spent budget can still cut off is the work that follows the call (the slot
// refresh, the mirror cleanup, the tier alert), and the call's own ANSWER, which the
// confirm then reads back.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-committed-deadline.ts
import {
  bookViaApi,
  createBooking,
  processBookingReservations,
  timeoutAsRetryable,
  DependencyTimeoutError,
  type BookingDeps,
} from "../src/lib/booking/orchestration.ts";
import type { Booking, BookingReservation } from "../src/lib/db/types.ts";
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
 * Deps where the save asks the budget and spends it on the way out: the commit
 * lands, then the clock is past the 12 seconds, so every budgeted call after it is
 * refused. `lostAnswer` makes the save's answer itself the casualty: it committed,
 * and the client gave up waiting, as a deadline on the call does.
 */
function committedThenSpent(clock: ReturnType<typeof confirmClock>, opts: { lostAnswer?: boolean } = {}) {
  const fixture = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
  const { deps } = fixture;
  let reservation: BookingReservation | null = null;
  let committed: Booking | null = null;
  const d: BookingDeps & typeof deps = {
    ...deps,
    insertReservation: async (row) => {
      reservation = await deps.insertReservation(row);
      return reservation;
    },
    commitFreshBooking: async (req) => {
      clock.call("supabase");
      const answer = await deps.commitFreshBooking.call(d, req);
      if (answer.kind === "committed") committed = answer.booking;
      clock.spend();
      if (opts.lostAnswer) {
        throw new Error("the booking commit got no answer", {
          cause: new DeadlineExceededError("supabase", 0, { label: "the booking confirm", totalMs: 12_000 }),
        });
      }
      return answer;
    },
    // The read back by the lead's key runs under the cleanup allowance, so it is not budgeted.
    findBookingByIdempotencyKey: async (key) => committed ?? (await deps.findBookingByIdempotencyKey(key)),
    invalidateSlots: async (code) => {
      clock.call("supabase");
      await deps.invalidateSlots(code);
    },
    resolveBucketByCode: async (code) => {
      clock.call("supabase");
      return deps.resolveBucketByCode(code);
    },
  };
  return {
    ...fixture,
    d,
    reservation: () => reservation,
    committed: () => committed,
  };
}

/** Booking fakes whose webhook step fails inside the save, so the reservation is left
 *  for the drain and the confirm answers with the work after its save unfinished (#3267). */
function makeDepsLeftToDrain(): BookingDeps {
  const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
  return {
    ...deps,
    emitWebhook: async () => {
      throw new Error("webhook_deliveries insert refused");
    },
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
      res !== null && committed !== null && res.booking.id === committed.id,
      "committed then spent: the answer carries the booking that was saved",
    );
    assert(
      res?.newlyInserted === true,
      "committed then spent: it is still this confirm's own save, so the race tally counts it once",
    );
    assert(f.calls.insertBooking.length === 1, "committed then spent: one save, nothing written twice");
    // #3495: the busy block, the webhook and the reservation's delete are inside the
    // save, so a budget spent after it cannot cut them off.
    assert(
      f.calls.moveBusyBlock.length === 1 && f.calls.webhooks.some((w) => w.event === "booking.created"),
      "committed then spent: the busy block and booking.created went in with the save",
    );
    assert(f.calls.deletedReservations.length === 1, "committed then spent: and the reservation went with them");
    assert(
      f.calls.invalidateSlots.length === 0,
      "control: the work after the save really was cut off (the slot refresh was refused), so the case is the cut off one",
    );
  }

  // --- 1b. the save committed and its ANSWER was lost to the deadline ----------
  // The client gave up waiting while Postgres committed. The confirm reads the
  // booking back by the lead's key, under the cleanup allowance, and answers it,
  // rather than telling a lead to retry for a booking that exists (red team 3).
  {
    const clock = confirmClock();
    const f = committedThenSpent(clock, { lostAnswer: true });
    const { value: res, err } = await settle(() => clock.run(() => createBooking(input, f.d)));
    assert(err === null, `answer lost: the confirm answers the booking, not a 503 (got ${said(err)})`);
    const committed = f.committed();
    assert(res !== null && committed !== null && res.booking.id === committed.id, "answer lost: the booking read back is the one saved");
    assert(res?.newlyInserted === true, "answer lost: and it is this confirm's own save");
    assert(f.calls.enqueueEventDeletion.length === 0, "answer lost: its calendar event is NOT queued for deletion");
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
      calls.insertBooking.length === 1 && calls.deletedReservations.length === 1,
      "a non-deadline failure after the commit: the save's own writes landed, the reservation's delete with them",
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
      // #3847: the drain's resume finds the committed booking through its any status
      // lookup, so that is the read this case must answer for the committed path to run.
      findLatestBookingByIdempotencyKey: async () => res.booking,
      resolveBucketByCode: async () => {
        throw new Error("buckets read down");
      },
    };
    const out = await processBookingReservations(d, 10);
    assert(
      calls.createEvent.length === 0 && calls.insertBooking.length === 0,
      "drain: the committed booking is found, so the failure is in its finish and nothing is made again",
    );
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
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      reservation,
    });
    const d: BookingDeps = {
      ...deps,
      // The replay fast path misses (the booking was read a moment before it
      // committed), and the resume's own lookup (#3847: by key in any status)
      // finds it.
      findBookingByIdempotencyKey: async () => null,
      findLatestBookingByIdempotencyKey: async () => made.booking,
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

  // --- 8. a confirm that left its follow up work to the drain SAYS so (#3267) --
  // It answers the booking, which is right, and the route counts it against the
  // confirms that committed so a wave of them pages on a rate (L77). A log line
  // alone was all there was.
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const d: BookingDeps = {
      ...deps,
      emitWebhook: async () => {
        throw new Error("webhook_deliveries insert refused");
      },
    };
    const res = await createBooking(input, d);
    assert(res.booking !== undefined, "left to the drain: the lead still gets the booking");
    assert(calls.deletedReservations.length === 0, "left to the drain: the reservation stays for the drain");
    assert(res.followUpLeftToDrain === true, "left to the drain: the answer says the work was left to the drain");
    const viaApi = await bookViaApi({ ...input, externalId: "ext-left", confirmReschedule: false }, makeDepsLeftToDrain());
    assert(
      viaApi.outcome === "created" && viaApi.followUpLeftToDrain === true,
      "left to the drain: the booking API's create arm carries it to its route too",
    );
  }
  {
    // Control: a confirm whose work all landed says nothing, so the count is only
    // the ones that really left work behind.
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const res = await createBooking(input, deps);
    assert(res.followUpLeftToDrain === undefined, "control: a confirm that finished its work is not counted");
    const viaApi = await bookViaApi({ ...input, externalId: "ext-clean", confirmReschedule: false }, makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
    }).deps);
    assert(
      viaApi.outcome === "created" && viaApi.followUpLeftToDrain === undefined,
      "control: nor is the booking API's",
    );
  }

  finish();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

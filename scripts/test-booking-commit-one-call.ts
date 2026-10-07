// A fresh booking's save after its calendar event is ONE call (#3495 step 3).
//
// `commit_fresh_booking` (migration 0174) writes the booking, its busy block, its
// webhook deliveries, its routing record and the reservation's delete in one
// transaction; what each step does in the database is proved in a real Postgres by
// scripts/verify-commit-fresh-booking-sql.ts. What is pinned here is the confirm
// around it: that it makes the one call carrying the right booking, webhook and
// routing record; how it reads each answer; and the two failures a single call
// makes new. A failure Postgres refused wrote NOTHING, while a failure with no
// answer (a deadline, a dropped connection) may have COMMITTED, so the confirm reads
// the booking back before telling a lead their booking failed (red team 3).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-commit-one-call.ts
import { createBooking, processBookingReservations, CommitRefusedError, type CommitFreshInput } from "../src/lib/booking/orchestration.ts";
import type { BookingReservation } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, makeBooking, input } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

type Made = ReturnType<typeof makeDeps>;

/** Count the commit calls, keeping the fake's own model of the function behind them. */
function counted(made: Made) {
  const commits: CommitFreshInput[] = [];
  const model = made.deps.commitFreshBooking;
  made.deps.commitFreshBooking = function (this: unknown, req: CommitFreshInput) {
    commits.push(req);
    return model.call(this, req);
  };
  return commits;
}

async function main() {
  // The lookups by the lead's key a confirm makes before its save, measured on an
  // ordinary booking, so the read back below is counted against it rather than
  // against a number written here.
  let lookupsBeforeSave = -1;
  // --- one call, carrying the booking, the webhook and the routing record ----------------
  {
    const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const commits = counted(made);
    const res = await createBooking(input, made.deps);
    assert(res.booking.id === "bk-new", `the booking is the one the call committed (got ${res.booking.id})`);
    assert(commits.length === 1, `exactly one commit call (got ${commits.length})`);
    const req = commits[0]!;
    assert(req.booking.id === "bk-new", `the row carries the id the confirm minted, which the webhook names (got ${req.booking.id})`);
    assert(req.booking.gcal_event_id !== "" && req.booking.assigned_user_id === "a", "and the calendar event and advisor it was given");
    assert(req.webhook.payload.booking_id === "bk-new", "the webhook names the booking");
    assert(req.webhook.dedupeKey === "bk-new", "its dedupe key is the booking's id, so a resume sends nothing twice");
    assert(req.webhook.suppressed === false, "a real bucket's webhook is sent");
    assert(req.routing?.bookingId === "bk-new" && req.routing.outcome === "booked", "the routing record names the booking");
    assert(made.calls.deletedReservations.length === 1, "the reservation is deleted inside the call");
    lookupsBeforeSave = made.calls.idempotencyLookups.length;
    assert(lookupsBeforeSave >= 1, `an ordinary booking looks the key up before its save (got ${lookupsBeforeSave})`);
  }

  // --- an agent link booking routes nothing --------------------------------------------------
  // (The routing record is absent; covered with the link's own fixtures in
  // scripts/test-agent-link-booking.ts, which also runs through this one call.)

  // --- the webhook step failed: the booking stands, the reservation stays for the drain ------
  {
    const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    made.deps.emitWebhook = async () => {
      throw new Error("enqueue refused");
    };
    const res = await createBooking(input, made.deps);
    assert(res.booking.id === "bk-new", "a failed webhook step still answers the booking");
    assert(made.calls.deletedReservations.length === 0, "and the reservation stays, so the drain re-runs the side effects and the webhook is not lost");
  }

  // --- the stray gcal mirror is cleared AFTER the answer (#586) ------------------------------
  {
    const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const scheduled: (() => Promise<void>)[] = [];
    made.deps.deferSend = (work) => {
      scheduled.push(work);
    };
    await createBooking(input, made.deps);
    assert(made.calls.deleteGcalMirror.length === 0, "nothing deletes the mirror before the lead is answered");
    for (const work of scheduled) await work();
    assert(made.calls.deleteGcalMirror.length === 1 && made.calls.deleteGcalMirror[0]!.userId === "a",
      "the scheduled work clears it, for the booked advisor");
  }
  {
    const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    await createBooking(input, made.deps);
    assert(made.calls.deleteGcalMirror.length === 1, "with nothing to schedule on (the drain), it is cleared inline");
  }
  // The save has already deleted the reservation, so nothing retries the work after it:
  // a slot refresh that throws must not take the mirror's delete down with it (L73).
  {
    const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    made.deps.invalidateSlots = async () => {
      throw new Error("slot refresh refused");
    };
    const res = await createBooking(input, made.deps);
    assert(res.booking.id === "bk-new", "a slot refresh that throws still answers the booking");
    assert(made.calls.deleteGcalMirror.length === 1, `and the stray mirror is still cleared (got ${made.calls.deleteGcalMirror.length})`);
  }
  // Nor is it reported to the drain as work left over: the reservation is gone, so the
  // drain would back off on a row that no longer exists. The recompute lane reconverges.
  {
    const first = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    let written: BookingReservation | undefined;
    const insertReservation = first.deps.insertReservation;
    first.deps.insertReservation = async (row) => {
      written = { ...row, id: "resv-refresh", status: "pending", lease_until: null, attempts: 0, last_error: null, next_attempt_at: null, created_at: "", updated_at: "" } as unknown as BookingReservation;
      return insertReservation(row);
    };
    await createBooking(input, first.deps);
    assert(written !== undefined, "the fresh confirm wrote a reservation to drain");
    const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]), drainableReservations: [written!] });
    made.deps.invalidateSlots = async () => {
      throw new Error("slot refresh refused");
    };
    const res = await processBookingReservations(made.deps, 15);
    assert(res.completed === 1 && res.failed === 0, `the drain counts the booking completed (got ${JSON.stringify(res)})`);
    assert(made.calls.reservationBumps.length === 0, `and bumps no attempt on the deleted reservation (got ${made.calls.reservationBumps.length})`);
  }

  // --- refused by Postgres: nothing was written, so the confirm fails as before --------------
  {
    const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    made.deps.commitFreshBooking = async () => {
      throw new CommitRefusedError({ code: "42501", message: "permission denied for function commit_fresh_booking" });
    };
    let threw: unknown = null;
    try {
      await createBooking(input, made.deps);
    } catch (err) {
      threw = err;
    }
    assert(threw instanceof Error && /Failed to persist booking/.test(threw.message), `a refused commit fails the confirm (got ${String(threw)})`);
    assert(made.calls.enqueueEventDeletion.length === 1, "and the calendar event is queued for deletion, held while the reservation is pending (#3215)");
    assert(made.calls.idempotencyLookups.length === lookupsBeforeSave,
      `with no read back: a refusal wrote nothing (got ${made.calls.idempotencyLookups.length} lookups, an ordinary booking makes ${lookupsBeforeSave})`);
  }

  // --- no answer at all, and the booking DID commit: the lead is answered the booking ---------
  {
    const committed = makeBooking({ id: "bk-new", idempotency_key: "k-late", assigned_user_id: "a" });
    const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]), conflictWinner: committed });
    const model = made.deps.commitFreshBooking;
    made.deps.commitFreshBooking = async function (this: unknown, req: CommitFreshInput) {
      await model.call(this, req);
      throw new Error("the connection closed before the answer");
    };
    const res = await createBooking(input, made.deps);
    assert(res.booking.id === "bk-new", `a commit whose answer was lost is read back and answered (got ${res.booking.id})`);
    assert(made.calls.enqueueEventDeletion.length === 0, "and its calendar event is NOT queued for deletion");
    assert(made.calls.idempotencyLookups.length === lookupsBeforeSave + 1,
      `the read back is one more lookup by the lead's key (got ${made.calls.idempotencyLookups.length}, an ordinary booking makes ${lookupsBeforeSave})`);
  }

  // --- no answer, and nothing committed: fail as a refused commit does -------------------------
  {
    const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    made.deps.commitFreshBooking = async () => {
      throw new Error("the connection closed before the answer");
    };
    let threw: unknown = null;
    try {
      await createBooking(input, made.deps);
    } catch (err) {
      threw = err;
    }
    assert(threw instanceof Error && /Failed to persist booking/.test(threw.message), `a lost answer with no booking behind it fails the confirm (got ${String(threw)})`);
    assert(made.calls.enqueueEventDeletion.length === 1, "and queues the calendar event's deletion");
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

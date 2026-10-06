// Google refusing the lead's email on every path that writes it to an invite
// OTHER than the create (#3373). #3359 typed the refusal on the create; these
// paths still let it out as a raw Google error, so a lead moving their call saw
// `reschedule_internal` and a manager reassigning it saw a generic 500, neither of
// which says the email is the problem.
//
// Found by enumerating every event write that carries an attendee (L247), not
// from the issue's list: `createEvent` in the reschedule reroute, in the in place
// recreate of a deleted event, and in `reassignBooking`, plus `updateEventContact`
// when a lead corrects their email (it PATCHes the attendee). The bulk coverage
// sweep reaches `reassignBooking` and gets its own case, since a refusal there
// can never succeed on a retry.
//
// Each case asserts the refusal is typed AND that the booking is exactly as it
// was: not moved, no event queued or deleted, the reschedule lock released, no
// reassign intent left for the sweep. Each also carries a control with another
// Google 400 `invalid`, which is our own fault and must keep its old handling.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-attendee-email-refusal-moves.ts
import {
  rescheduleBooking,
  reassignBooking,
  updateBookingContact,
  AttendeeEmailRefusedError,
  ContactRefusedError,
  type BookingDeps,
} from "../src/lib/booking/orchestration.ts";
import { ATTENDEE_EMAIL_REFUSED_STAFF } from "../src/lib/booking/attendee-email-refused.ts";
import { processBulkReassignItem, type BulkReassignDeps } from "../src/lib/booking/bulk-reassign.ts";
import { GoogleHttpError } from "../src/lib/google/http-error.ts";
import { INVALID_EMAIL } from "../src/lib/attendee.ts";
import type { Booking, BulkReassignItem, BulkReassignJob, User } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, makeBooking, bucket, eventType, RR, SYS, NOW } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const TARGET = "2026-06-08T18:00:00.000Z";
/** A is off shift at TARGET, so the move reroutes to B: the reassign branch. */
const OFF_SHIFT_A = new Map([
  ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 810 }] }],
]);

/** Google's refusal, verbatim from production (#3359). */
function refusal(): GoogleHttpError {
  return new GoogleHttpError(
    'events.insert failed: 400 {"error":{"errors":[{"domain":"global","reason":"invalid","message":"Invalid attendee email."}],"code":400}}',
    400,
    "invalid",
  );
}
/** Another 400 `invalid`: a malformed field of OURS, which must stay internal. */
function ourFault(): GoogleHttpError {
  return new GoogleHttpError(
    'events.insert failed: 400 {"error":{"errors":[{"domain":"global","reason":"invalid","message":"Invalid start time."}],"code":400}}',
    400,
    "invalid",
  );
}

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  return null;
}

/** The fields a move or a reassign would change, so "unchanged" is one comparison. */
function snapshot(b: Booking) {
  return JSON.stringify({
    starts_at: b.starts_at,
    ends_at: b.ends_at,
    assigned_user_id: b.assigned_user_id,
    agent_email: b.agent_email,
    gcal_event_id: b.gcal_event_id,
    status: b.status,
    reschedule_seq: b.reschedule_seq,
    attendee_email: b.attendee_email,
    attendee_name: b.attendee_name,
    attendee_phone: b.attendee_phone,
  });
}

/** A reschedule world whose createEvent throws `fail()` on every insert. */
function rescheduleWorld(fail: () => Error, opts: { inPlaceGone?: boolean } = {}) {
  const ctx = { booking: makeBooking({ gcal_event_id: "gcal-old" }), bucket, eventType };
  const before = snapshot(ctx.booking);
  const { deps, calls } = makeDeps({
    existing: ctx,
    bookingById: ctx,
    candidates: ["b"],
    freeEmails: new Set(["a@x.com", "b@x.com"]),
    // The in place case keeps A on shift, so the PATCH is tried and finds the event gone.
    ...(opts.inPlaceGone ? { updateEventTimeGone: true } : { workingHoursByUser: OFF_SHIFT_A }),
  });
  const d: BookingDeps = {
    ...deps,
    createEvent: async (email, _args, clientId) => {
      calls.createEvent.push({ email, clientId });
      throw fail();
    },
  };
  return { ctx, before, d, calls };
}

async function run() {
  // --- 1. reschedule, reroute branch: the new advisor's invite is refused -------
  {
    const { ctx, before, d, calls } = rescheduleWorld(refusal);
    const err = await caught(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(calls.createEvent.length === 1 && calls.createEvent[0].email === "b@x.com", "reroute: the precondition, the move reached B's create");
    assert(err instanceof AttendeeEmailRefusedError, "reroute: the refusal is typed as the email, not a raw Google error");
    assert(
      err instanceof AttendeeEmailRefusedError && err.message === INVALID_EMAIL && err.cause instanceof GoogleHttpError,
      "reroute: it carries the email field's sentence, with Google's answer as its cause",
    );
    assert(snapshot(ctx.booking) === before, "reroute: the booking is exactly as it was");
    assert(calls.commitReschedule.length === 0, "reroute: nothing was committed");
    assert(
      calls.enqueueEventDeletion.length === 0 && calls.deleteEvent.length === 0,
      "reroute: no event deleted or queued, because Google wrote none",
    );
    assert(calls.releaseReschedule === 1, "reroute: the reschedule lock is released");
    assert((await d.readReschedulePin(ctx.booking.id)) === null, "reroute: no pin is left standing for the sweep");
    assert(calls.webhooks.length === 0 && calls.bookingEvents.length === 0, "reroute: nothing announced, nothing recorded as moved");
  }

  // --- 1b. control: another Google 400 keeps its old path (queued, internal) ---
  {
    const { ctx, d, calls } = rescheduleWorld(ourFault);
    const err = await caught(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(err instanceof GoogleHttpError && !(err instanceof AttendeeEmailRefusedError), "reroute control: a fault of ours stays a raw error");
    assert(
      calls.enqueueEventDeletion.some((r) => r.bookingId === ctx.booking.id),
      "reroute control: and its maybe written event is still queued, as before (#3217)",
    );
  }

  // --- 2. reschedule, in place: the event was deleted and its recreate is refused
  {
    const { ctx, before, d, calls } = rescheduleWorld(refusal, { inPlaceGone: true });
    const err = await caught(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(
      calls.updateEventTime.length === 1 && calls.createEvent.length === 1 && calls.createEvent[0].email === "a@x.com",
      "in place: the precondition, the PATCH found the event gone and the recreate ran on A",
    );
    assert(err instanceof AttendeeEmailRefusedError, "in place: the refused recreate is typed as the email");
    assert(snapshot(ctx.booking) === before, "in place: the booking is exactly as it was");
    assert(calls.commitReschedule.length === 0, "in place: nothing was committed");
    assert(calls.enqueueEventDeletion.length === 0, "in place: no deletion queued for an event Google never wrote");
    assert(calls.releaseReschedule === 1, "in place: the reschedule lock is released");
    assert((await d.readReschedulePin(ctx.booking.id)) === null, "in place: no pin is left standing");
  }
  {
    const { d, calls } = rescheduleWorld(ourFault, { inPlaceGone: true });
    const err = await caught(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(
      err instanceof GoogleHttpError && calls.enqueueEventDeletion.length === 1,
      "in place control: a fault of ours stays raw and its event is still queued",
    );
  }

  // --- 3. reassignBooking: the target advisor's invite is refused ---------------
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const before = snapshot(ctx.booking);
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    const d: BookingDeps = {
      ...deps,
      createEvent: async (email, _args, clientId) => {
        calls.createEvent.push({ email, clientId });
        throw refusal();
      },
    };
    const err = await caught(() => reassignBooking("bk1", "b@x.com", SYS, d));
    assert(err instanceof AttendeeEmailRefusedError, "reassign: the refusal is typed as the email");
    assert(snapshot(ctx.booking) === before, "reassign: the booking is exactly as it was");
    assert(calls.reassignSwaps.length === 0, "reassign: no swap ran");
    assert(
      calls.enqueueEventDeletion.length === 0 && calls.deleteEvent.length === 0,
      "reassign: no event deleted or queued, because Google wrote none",
    );
    const written = calls.reassignIntents.map((r) => r.gcalClientId);
    assert(
      written.length === 1 &&
        written.every((id) => calls.reassignIntentDeletes.some((x) => x.bookingId === "bk1" && x.gcalClientId === id)),
      "reassign: the intent written before the create is cleared, so the sweep never reports a lost reassign",
    );
    assert(calls.webhooks.length === 0, "reassign: nothing announced");
  }
  {
    // Control: a fault of ours leaves the intent for the abandoned intent sweep, as before.
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    const d: BookingDeps = { ...deps, createEvent: async () => { throw ourFault(); } };
    const err = await caught(() => reassignBooking("bk1", "b@x.com", SYS, d));
    assert(
      err instanceof GoogleHttpError && calls.reassignIntentDeletes.length === 0,
      "reassign control: a fault of ours stays raw and its intent stays for the sweep",
    );
  }

  // --- 4. the lead corrects their email and Google refuses the new address -----
  // The row is written first (#2164), so a refusal must put it back: otherwise the
  // address Google refused is stored, and every later move of this call carries it.
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const before = snapshot(ctx.booking);
    const { deps, calls } = makeDeps({ existing: ctx, bookingById: ctx });
    const d: BookingDeps = {
      ...deps,
      updateEventContact: async (email, id, patch) => {
        calls.updateEventContact.push({ email, id, patch });
        throw refusal();
      },
    };
    const res = await updateBookingContact("tok1", { email: "new@x.com", name: "Kris New", phone: "+12035550100" }, d);
    assert(
      calls.updateEventContact.length === 1 && calls.updateEventContact[0].patch.attendeeEmail === "new@x.com",
      "contact: the precondition, the invite PATCH carried the new address",
    );
    assert(!res.ok && res.error === INVALID_EMAIL, "contact: the correction is refused with the email field's sentence");
    const last = calls.updateBookingContact[calls.updateBookingContact.length - 1]?.patch;
    assert(
      calls.updateBookingContact.length === 2 &&
        last?.attendee_email === "k@x.com" &&
        last?.attendee_name === "Kris" &&
        last?.attendee_phone === "+12035615295",
      "contact: the row write is reverted to every value it held before",
    );
    assert(snapshot(ctx.booking) === before, "contact: and the in memory row a move would build from is put back");
  }
  {
    // Through the move: the refusal stops the reschedule before any lock or Google write.
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const before = snapshot(ctx.booking);
    const { deps, calls } = makeDeps({ existing: ctx, bookingById: ctx, freeEmails: new Set(["a@x.com"]) });
    const d: BookingDeps = { ...deps, updateEventContact: async () => { throw refusal(); } };
    const err = await caught(() =>
      rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW, undefined, { email: "new@x.com" }),
    );
    assert(
      err instanceof ContactRefusedError && err.message === INVALID_EMAIL,
      "contact via a move: refused as the detail the lead typed",
    );
    assert(calls.claimReschedule === 0 && calls.createEvent.length === 0, "contact via a move: nothing was moved or written to Google");
    assert(snapshot(ctx.booking) === before, "contact via a move: the booking is exactly as it was");
  }
  {
    // Control: an unwell Google keeps the saved correction and reports the invite stale (#2164).
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, bookingById: ctx, updateEventDescriptionThrows: true });
    const res = await updateBookingContact("tok1", { email: "new@x.com" }, deps);
    assert(
      res.ok && res.staleInvite !== undefined && calls.updateBookingContact.length === 1,
      "contact control: a 503 keeps the correction and reports the invite stale, unreverted",
    );
  }
  {
    // Failure path: a revert that cannot be written is a fault, never a reported success.
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps } = makeDeps({ existing: ctx, bookingById: ctx });
    let writes = 0;
    const d: BookingDeps = {
      ...deps,
      updateBookingContact: async () => {
        writes++;
        if (writes === 2) throw new Error("db write failed");
      },
      updateEventContact: async () => { throw refusal(); },
    };
    const err = await caught(() => updateBookingContact("tok1", { email: "new@x.com" }, d));
    assert(err instanceof Error && err.message === "db write failed", "contact: a failed revert throws its own error rather than answering ok");
  }

  // --- 5. the bulk coverage sweep: a refusal is terminal on the first attempt ----
  {
    const job = { id: "job1", out_user_id: "out", status: "active" } as unknown as BulkReassignJob;
    const item = { id: "it1", job_id: "job1", booking_id: "bk1", status: "pending", attempts: 0 } as unknown as BulkReassignItem;
    const deps = (reassignErr: Error) =>
      ({
        loadBooking: async (id: string) => ({ id, status: "confirmed", assigned_user_id: "out" }),
        selectTarget: async () => ({ assignment: { userId: "cov", email: "cov@x.com" }, anyUnverified: false }),
        reassign: async () => {
          throw reassignErr;
        },
      }) as unknown as BulkReassignDeps;
    const refused = await processBulkReassignItem(item, job, deps(new AttendeeEmailRefusedError(refusal())));
    assert(
      refused.status === "failed" && refused.detail === ATTENDEE_EMAIL_REFUSED_STAFF,
      "bulk: a refused email fails the item at once, saying the email is why",
    );
    const transient = await processBulkReassignItem(item, job, deps(new Error("google 503")));
    assert(transient.status === "pending", "bulk control: an ordinary failure is still retried");
  }

  finish();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

// A lead who comes back and types DIFFERENT details, then moves the call they
// already have (#2164). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-move-carries-contact.ts
//
// WHAT THIS EXISTS TO STOP. Seen live on the 2026-09-09 pilot booking. A lead
// booked on `/booking/pilot-dwright-1`, came back to the same link, and entered a
// different email and phone. The Salesforce id in the path is a strong match, so
// the booker correctly recognised the existing call and offered the move; the move
// changed the time and nothing else. The booking kept the original address, Google
// rewrote the invite for it, Regal received `booking.rescheduled` against it, and
// nothing on screen said so. A real lead's commonest reason to come back with
// different details is that the first ones were wrong, so the advisor then rings
// the number they just replaced.
//
// THE ORDERING IS THE POINT, and it is what a test has to hold. The calendar event
// and the webhook payload are both built from the booking row, so the correction
// has to land BEFORE the move rather than after it: applied afterwards it would
// reach neither, and both halves would go out against the details the lead came
// back to replace.
import { rescheduleBooking, updateBookingContact } from "../src/lib/booking/orchestration.ts";
import { movedContactNote } from "../src/lib/booking/booker-copy.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const TOKEN = "tok-move";
/** Far enough ahead that no minimum notice rule refuses it. */
const NEW_START = "2026-10-01T15:00:00.000Z";

function world(
  overrides: Parameters<typeof makeDeps>[0] = {},
  bookingOverrides: Partial<ReturnType<typeof makeBooking>> = {},
) {
  const booking = makeBooking({
    id: "bk-1",
    manage_token: TOKEN,
    attendee_name: "Dana Old",
    attendee_email: "old@example.com",
    // E.164, which is what every write stores and what the person lookup asks the
    // column for (#2390). A fixture holding the old formatted shape would let a
    // correction that reintroduced it read as no change at all.
    attendee_phone: "+12155550100",
    gcal_event_id: "gcal-1",
    ...bookingOverrides,
  });
  return makeDeps({ ...overrides, existing: { booking, bucket, eventType } });
}

const reason = { code: "other" as const, detail: "changed my mind" };

async function run() {
  // --- the correction lands on the booking, before anything reads it ------------
  {
    const { deps, calls } = world();
    const res = await updateBookingContact(
      TOKEN,
      { name: "Dana New", email: "new@example.com", phone: "2155559999" },
      deps,
    );
    assert(res.ok, "the corrected details are accepted");
    assert(calls.updateBookingContact.length === 1, "and written in ONE write, not three");
    const patch = calls.updateBookingContact[0].patch;
    assert(
      patch.attendee_name === "Dana New" &&
        patch.attendee_email === "new@example.com" &&
        patch.attendee_phone === "+12155559999",
      `every field the lead changed is in it, the number in the shape the person lookup asks the column for (got ${JSON.stringify(patch)})`,
    );
    assert(
      res.ok && res.changed.name && res.changed.email && res.changed.phone,
      "and the caller is told which of them moved, so the screen can say it",
    );
  }

  // --- the invite is rewritten, and WHO is invited moves with the address -------
  //
  // The advisor reads the number off the invite and the lead reads the invite in
  // whichever inbox it reached, so a correction that stops at the database leaves
  // both of them with the details the lead came back to replace.
  {
    const { deps, calls } = world();
    await updateBookingContact(TOKEN, { email: "new@example.com" }, deps);
    assert(calls.updateEventContact.length === 1, "the invite is patched once");
    const patch = calls.updateEventContact[0].patch;
    assert(patch.attendeeEmail === "new@example.com", "the attendee is the new address");
    assert(
      patch.description === undefined && patch.summary === undefined,
      "and nothing else is sent, because nothing else moved",
    );
  }

  // --- nothing moved, so nothing happens ---------------------------------------
  //
  // THE CONTROL. Without it, a version that wrote the row and rewrote the invite
  // on every move would satisfy every assertion above, and every returning lead
  // who retyped the SAME details would cost a write, an invite rewrite, and an
  // email to both people saying their event had been updated (L1).
  {
    const { deps, calls } = world();
    const res = await updateBookingContact(
      TOKEN,
      { name: "Dana Old", email: "old@example.com", phone: "(215) 555-0100" },
      deps,
    );
    assert(res.ok, "retyping the same details is not an error");
    assert(calls.updateBookingContact.length === 0, "and writes nothing at all");
    assert(calls.updateEventContact.length === 0, "and rewrites no invite");
    assert(
      res.ok && !res.changed.name && !res.changed.email && !res.changed.phone,
      "and reports that nothing moved, so the screen says nothing",
    );
  }

  {
    // An address that differs only in case is the same mailbox. Rewriting the
    // invite for it would email both people about nothing.
    const { deps, calls } = world();
    const res = await updateBookingContact(TOKEN, { email: "OLD@Example.com" }, deps);
    assert(res.ok && !res.changed.email, "a case-only difference is not a change");
    assert(calls.updateBookingContact.length === 0, "so nothing is written");
  }

  // --- a value we cannot use refuses, and the call does NOT move ---------------
  //
  // Refusing is the only honest answer: writing them is the point of having been
  // given them, and moving the call while dropping them is what this issue is
  // about (L12).
  {
    const { deps, calls } = world();
    let thrown: unknown;
    try {
      await rescheduleBooking(
        TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
        undefined, { email: "not-an-address" },
      );
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && thrown.name === "ContactRefusedError",
      `the move is refused by its own type (got ${String(thrown)})`,
    );
    assert(
      thrown instanceof Error && /valid email/i.test(thrown.message),
      "carrying the sentence about the value they typed, not a generic failure",
    );
    assert(calls.updateBookingContact.length === 0, "nothing is written");
    assert(calls.commitReschedule.length === 0, "and the call does not move");
  }

  {
    // The fields nobody sent are not judged. A move that carried only a corrected
    // number must not be refused with "Enter your name" about a name that was
    // never in question (L11).
    const { deps } = world();
    const res = await updateBookingContact(TOKEN, { phone: "2155559999" }, deps);
    assert(res.ok, `a one field correction is accepted (got ${res.ok ? "" : res.error})`);
  }

  // --- the move carries them, and carries them FIRST ---------------------------
  {
    const { deps, calls } = world();
    const res = await rescheduleBooking(
      TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
      undefined, { name: "Dana New", email: "new@example.com", phone: "2155559999" },
    );
    assert(calls.updateBookingContact.length === 1, "the correction is written");
    assert(calls.commitReschedule.length === 1, "and the call moves");
    // THE ORDERING, asserted through the thing it exists for rather than through a
    // list of call names: the payload downstream receives is built from the row, so
    // it carries the corrected address only if the correction landed first. This is
    // the exact half that went wrong on the pilot booking, where Regal received
    // `booking.rescheduled` against the address the lead had just replaced.
    const moved = calls.webhooks.filter((w) => w.event === "booking.rescheduled");
    assert(moved.length === 1, `one rescheduled event went out (got ${moved.length})`);
    assert(
      moved[0]?.attendee?.email === "new@example.com",
      `and it carries the corrected address (got ${JSON.stringify(moved[0]?.attendee)})`,
    );
    assert(
      moved[0]?.attendee?.phone === "+12155559999",
      "and the corrected number, so a dialler working from it rings the right one",
    );
    assert(
      res.contactChanged?.email === true,
      "and the result says what else changed, so the screen can say it",
    );
  }

  {
    // A move that changed nothing but the time reports NO contact change, so the
    // screen shows no line rather than a sentence claiming one. The number is typed
    // with punctuation and stored as E.164, and they are one number, so it did not
    // move either (#2390).
    const { deps } = world();
    const res = await rescheduleBooking(
      TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
      undefined, { name: "Dana Old", email: "old@example.com", phone: "(215) 555-0100" },
    );
    assert(res.contactChanged === null, "nothing moved, so nothing is claimed");
  }

  // --- the move tells Regal the number was CORRECTED (#4031) ---------------------
  //
  // A corrected number rides `booking.rescheduled` (#2164), and Regal names a number
  // primary and subscribed only when the event says it was corrected (Dan,
  // 2026-10-21: a number a lead types counts as consent). So the payload carries the
  // number the move replaced, taken off the outbox row, which a drain re-run reads
  // too. Without it Regal adds the new number and keeps ringing the old primary one.
  {
    const { deps, calls } = world();
    await rescheduleBooking(
      TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
      undefined, { phone: "2155559999" },
    );
    const moved = calls.webhooks.filter((w) => w.event === "booking.rescheduled");
    assert(moved.length === 1, `one rescheduled event went out (got ${moved.length})`);
    assert(
      moved[0]?.previousPhone === "+12155550100",
      `and it carries the number the move replaced (got ${String(moved[0]?.previousPhone)})`,
    );
    const outbox = calls.commitReschedule[0]?.outbox?.payload as { previousAttendeePhone?: unknown } | undefined;
    assert(
      outbox?.previousAttendeePhone === "+12155550100",
      `recorded on the outbox row, so a drain re-run of the notify step says the same (got ${String(outbox?.previousAttendeePhone)})`,
    );
  }

  // --- a correction the move does NOT carry is still told (#4031) ---------------
  //
  // The number is written BEFORE the move is tried, so a move that then fails (a
  // conflict, a refused slot) or turns out to be no move at all leaves it saved
  // with no booking.rescheduled to carry it. The lead's retry types the same number,
  // which moves nothing, so that retry's event could not say it either, and Regal
  // would go on ringing the old primary number. So the correction goes out as the
  // manage page's own booking.contact_updated instead.
  {
    const { deps, calls } = world();
    deps.claimReschedule = async () => ({ outcome: "conflict" });
    let thrown: unknown;
    try {
      await rescheduleBooking(
        TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
        undefined, { phone: "2155559999" },
      );
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof Error && thrown.name === "RescheduleConflictError", `the move still fails as itself (got ${String(thrown)})`);
    const told = calls.webhooks.filter((w) => w.event === "booking.contact_updated");
    assert(told.length === 1, `a failed move's correction goes out as one contact update (got ${calls.webhooks.map((w) => w.event).join(",")})`);
    assert(told[0]?.attendee.phone === "+12155559999", "carrying the new number");
    assert(told[0]?.previousPhone === "+12155550100", "and the one it replaced");
  }

  {
    // Failure path: the contact update cannot be recorded either. Nothing will retry
    // it, so the caller is handed the booking to page about, as the manage page's own
    // correction does, and the move's own error still reaches the lead untouched.
    const { deps } = world({ emitWebhookThrows: true });
    deps.claimReschedule = async () => ({ outcome: "conflict" });
    const untold: string[] = [];
    let thrown: unknown;
    try {
      await rescheduleBooking(
        TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
        undefined, { phone: "2155559999" },
        { onCorrectionUntold: async (bookingId) => void untold.push(bookingId) },
      );
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof Error && thrown.name === "RescheduleConflictError", `the move's own error is kept (got ${String(thrown)})`);
    assert(untold.join(",") === "bk-1", `the untold correction is handed back to page about (got ${untold.join(",")})`);
  }

  {
    // No move at all: the booking already sits at the time asked for.
    const { deps, calls } = world({}, { starts_at: NEW_START });
    await rescheduleBooking(
      TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
      undefined, { phone: "2155559999" },
    );
    const events = calls.webhooks.map((w) => w.event).join(",");
    assert(events === "booking.contact_updated", `a correction beside no move is told as a contact update alone (got ${events})`);
  }

  {
    // The control: a move that carries its correction says it ONCE, on its own
    // booking.rescheduled, never a second time as a contact update (L1).
    const { deps, calls } = world();
    await rescheduleBooking(
      TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
      undefined, { phone: "2155559999" },
    );
    const events = calls.webhooks.map((w) => w.event).join(",");
    assert(events === "booking.rescheduled", `a carried correction is told once, on the move (got ${events})`);
  }

  {
    // The control: a move that corrected only the email, or changed only the time,
    // replaced no number, so its payload names none and Regal asserts nothing (L1).
    for (const contact of [{ email: "new@example.com" }, { phone: "(215) 555-0100" }, undefined]) {
      const { deps, calls } = world();
      await rescheduleBooking(
        TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
        undefined, contact,
      );
      const moved = calls.webhooks.filter((w) => w.event === "booking.rescheduled");
      assert(moved.length === 1, `one rescheduled event went out for ${JSON.stringify(contact)}`);
      assert(
        moved[0]?.previousPhone === undefined,
        `and it names no replaced number for ${JSON.stringify(contact)} (got ${String(moved[0]?.previousPhone)})`,
      );
    }
  }

  {
    // Every other caller of the reschedule (the emailed manage link, the admin
    // move, the API) passes nothing, and must be untouched by this.
    const { deps, calls } = world();
    const res = await rescheduleBooking(
      TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
    );
    assert(calls.updateBookingContact.length === 0, "a move with no details typed writes none");
    assert(res.contactChanged === null, "and claims none");
    assert(calls.commitReschedule.length === 1, "while still moving the call");
  }

  // --- what the lead is told ----------------------------------------------------
  {
    assert(
      movedContactNote({ name: false, email: false, phone: false }) === null,
      "no change means no sentence",
    );
    const one = movedContactNote({ name: false, email: false, phone: true });
    assert(one === "We have updated your phone number for this call.", `one field reads as one (got ${one})`);
    const two = movedContactNote({ name: true, email: false, phone: true });
    assert(
      two === "We have updated your name and phone number for this call.",
      `two are joined with "and" and no comma (got ${two})`,
    );
    const all = movedContactNote({ name: true, email: true, phone: true });
    assert(
      all === "We have updated your name, email address and phone number for this call.",
      `three take a comma and an "and" (got ${all})`,
    );
    // It does NOT name the address. The line above it on that screen already says
    // where the invite is going, built from the same corrected value, so naming it
    // again is the same fact twice in two lines (L605). Found by reading the
    // rendered screen, which is the only place it was visible.
    assert(
      !(all ?? "").includes("@"),
      "and no address, because the line above it already names where the invite is going",
    );
  }


  // --- #2549: the answered first name travels with the name ---------------------
  {
    const { deps, calls } = world({}, { attendee_first_name: null });
    const res = await updateBookingContact(TOKEN, { name: "Mary Jo Smith", firstName: "Mary Jo" }, deps);
    assert(res.ok && res.changed.name, "a changed name is a change");
    const patch = calls.updateBookingContact[0]?.patch;
    assert(
      patch?.attendee_name === "Mary Jo Smith" && patch?.attendee_first_name === "Mary Jo",
      `the answered first name is written with it (got ${JSON.stringify(patch)})`,
    );
  }
  {
    // A name changed by a caller that sent no first name must not leave the OLD
    // first name beside the NEW name, where Regal would greet the lead by it.
    const { deps, calls } = world({}, { attendee_name: "Dana Old", attendee_first_name: "Dana" });
    await updateBookingContact(TOKEN, { name: "Robin New" }, deps);
    const patch = calls.updateBookingContact[0]?.patch;
    assert(
      patch !== undefined && "attendee_first_name" in patch && patch.attendee_first_name === null,
      `a name changed without a first name clears the stale one (got ${JSON.stringify(patch)})`,
    );
  }
  // --- #2835: a first name that moved on its own is stored ----------------------
  //
  // This REVERSES the #2549 control that stood here ("an unchanged name leaves the
  // stored first name alone"). That rule existed because a returning lead's form
  // was seeded by splitting the joined name, so an unedited "Mary" / "Jo Smith"
  // came back looking like an answer. The form now seeds from the answered first
  // name, and sends a first name back only when it IS an answer (seeded from one,
  // or edited by the lead), so a lead who fixes only the split gets it stored.
  {
    const { deps, calls } = world({}, { attendee_name: "Mary Jo Smith", attendee_first_name: "Mary Jo" });
    const res = await updateBookingContact(TOKEN, { name: "Mary Jo Smith", firstName: "Mary" }, deps);
    assert(res.ok && !res.changed.name, "moving the split is not a change to the name");
    const patch = calls.updateBookingContact[0]?.patch;
    assert(
      calls.updateBookingContact.length === 1 && patch?.attendee_first_name === "Mary",
      `the corrected first name is written (got ${JSON.stringify(calls.updateBookingContact)})`,
    );
    assert(patch !== undefined && !("attendee_name" in patch), "and the name it agrees with is left as it is");
    assert(calls.updateEventContact.length === 0, "and the invite, which carries only the joined name, is not rewritten");
  }
  {
    // The Mary Jo case itself: a legacy booking with no answered first name, and a
    // lead who moves the split to "Mary Jo" / "Smith".
    const { deps, calls } = world({}, { attendee_name: "Mary Jo Smith", attendee_first_name: null });
    await updateBookingContact(TOKEN, { name: "Mary Jo Smith", firstName: "Mary Jo" }, deps);
    assert(
      calls.updateBookingContact[0]?.patch.attendee_first_name === "Mary Jo",
      `"Mary Jo" / "Smith" is stored as answered (got ${JSON.stringify(calls.updateBookingContact)})`,
    );
  }
  {
    // A first name the unchanged name does not start with is not one fact with it,
    // and is never stored beside it, nor does it clear the answer already held.
    const { deps, calls } = world({}, { attendee_name: "Mary Jo Smith", attendee_first_name: "Mary Jo" });
    const res = await updateBookingContact(TOKEN, { name: "Mary Jo Smith", firstName: "Robin" }, deps);
    assert(res.ok, "a disagreeing first name is not a refusal");
    assert(calls.updateBookingContact.length === 0, "and writes nothing");
  }
  {
    const { deps, calls } = world({}, { attendee_name: "Mary Jo Smith", attendee_first_name: "Mary Jo" });
    await updateBookingContact(TOKEN, { name: "Mary Jo Smith", firstName: "Mary Jo" }, deps);
    assert(calls.updateBookingContact.length === 0, "the same first name again writes nothing");
  }
  {
    // No first name sent is no statement about it: the stored answer stays.
    const { deps, calls } = world({}, { attendee_name: "Mary Jo Smith", attendee_first_name: "Mary Jo" });
    await updateBookingContact(TOKEN, { name: "Mary Jo Smith" }, deps);
    assert(calls.updateBookingContact.length === 0, "an unchanged name with no first name keeps the stored one");
  }
  {
    // And a move carrying only the corrected split sends it to Regal.
    const { deps, calls } = world({}, { attendee_name: "Mary Jo Smith", attendee_first_name: "Mary" });
    await rescheduleBooking(
      TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
      undefined, { name: "Mary Jo Smith", firstName: "Mary Jo" },
    );
    const sent = calls.webhooks.find((w) => w.event === "booking.rescheduled");
    const attendee = sent?.attendee as { first_name?: string | null } | undefined;
    assert(attendee?.first_name === "Mary Jo", `the move carries the corrected first name (got ${JSON.stringify(attendee)})`);
  }
  {
    // And the move's own webhook payload carries it, since Regal is built from that.
    const { deps, calls } = world({}, { attendee_first_name: null });
    await rescheduleBooking(
      TOKEN, NEW_START, reason, "customer", deps, Date.parse("2026-09-10T12:00:00.000Z"),
      undefined, { name: "Mary Jo Smith", firstName: "Mary Jo" },
    );
    const sent = calls.webhooks.find((w) => w.event === "booking.rescheduled");
    const attendee = sent?.attendee as { first_name?: string | null } | undefined;
    assert(attendee?.first_name === "Mary Jo", `the rescheduled payload carries the answered first name (got ${JSON.stringify(attendee)})`);
  }

  finish();
}

void run();

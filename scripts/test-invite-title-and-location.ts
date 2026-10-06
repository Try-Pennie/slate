// The calendar invite names the advisor AND the lead, and carries the lead's phone
// as its location, like cal.com's (#3376). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-invite-title-and-location.ts
//
// WHY. Side by side in an advisor's calendar on 2026-10-06, cal.com's invite read
// "Senior Loan Advisor Call between David Menjivar and Brad Jones", 11:20am,
// +19728232983, and Slate's read "Senior Loan Advisor Call with Jason ONeal", 11am.
// The number after the time is the event's LOCATION, so the advisor sees who to
// call and what to dial without opening the event.
//
// EVERY PATH THAT WRITES AN INVITE IS DRIVEN HERE, because each one builds the
// event separately and a path left on the old shape is invisible from any other
// (L14, L94): the booking (and the reservation it resumes from), the in place
// reschedule that recreates a deleted event, the reschedule that reroutes to
// another advisor, the reassign, and the lead's own contact correction. The two
// that change WHO is named are the ones that matter most: a reroute and a reassign
// put a different advisor in the title, and a contact edit a different lead or
// number.
import {
  createBooking,
  processBookingReservations,
  reassignBooking,
  rescheduleBooking,
  updateBookingContact,
} from "../src/lib/booking/orchestration.ts";
import { eventLocation, eventSummary } from "../src/lib/booking/core.ts";
import type { BookingReservation, User } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  makeDeps,
  makeBooking,
  bucket,
  eventType,
  input,
  RR,
  SYS,
  NOW,
} from "./lib/booking-fakes.ts";


const TYPE = "Senior Loan Advisor Call";
/** The fixtures' lead, advisor and stored number (scripts/lib/booking-fakes.ts). */
const LEAD = "Kris";
const PHONE = "+12035615295";

async function run() {
  // --- the builder: every combination of names, and never a dangling word -----
  eq(
    eventSummary({ eventType: TYPE, advisor: "David Menjivar", lead: "Brad Jones" }),
    "Senior Loan Advisor Call between David Menjivar and Brad Jones",
    "both names: the cal.com shape, advisor first",
  );
  eq(
    eventSummary({ eventType: TYPE, advisor: null, lead: "Brad Jones" }),
    "Senior Loan Advisor Call with Brad Jones",
    "no advisor name: today's shape, naming the lead",
  );
  eq(
    eventSummary({ eventType: TYPE, advisor: "David Menjivar", lead: null }),
    TYPE,
    "no lead name: the appointment alone, never 'with' the advisor on their own calendar",
  );
  eq(eventSummary({ eventType: TYPE, advisor: null, lead: null }), TYPE, "neither: the appointment alone");
  // A blank or whitespace name is a missing one. Without this, "between  and Brad"
  // reaches a real calendar the first time a profile has an empty name.
  eq(
    eventSummary({ eventType: TYPE, advisor: "   ", lead: " Brad Jones " }),
    "Senior Loan Advisor Call with Brad Jones",
    "a blank advisor name is a missing one, and the lead's name is trimmed",
  );
  eq(eventSummary({ eventType: TYPE, advisor: "David", lead: "" }), TYPE, "an empty lead name is a missing one");
  for (const advisor of [null, "", " ", "David Menjivar"]) {
    for (const lead of [null, "", " ", "Brad Jones"]) {
      const t = eventSummary({ eventType: TYPE, advisor, lead });
      assert(
        !/\b(between|and|with)\s*$/.test(t) && !/\s{2}/.test(t) && !/between\s+and\b/.test(t),
        `no dangling word for advisor=${JSON.stringify(advisor)} lead=${JSON.stringify(lead)} (got ${JSON.stringify(t)})`,
      );
    }
  }
  eq(eventLocation(PHONE), PHONE, "the location is the number exactly as stored");
  eq(eventLocation(null), null, "no number, no location");
  eq(eventLocation(""), null, "an empty stored number is no number");
  eq(eventLocation("  "), null, "nor is a blank one");

  // --- the booking: the invite and the reservation it is written from ------------
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    await createBooking(input, deps);
    const args = calls.createEvent[0]?.args;
    eq(args?.summary, `${TYPE} between Agent A and ${LEAD}`, "booking: the title names the advisor who took it and the lead");
    eq(args?.location, PHONE, "booking: the location is the lead's number");
  }
  {
    const noPhone = { ...input, attendee: { name: LEAD, email: "k@x.com" } };
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    await createBooking(noPhone, deps);
    const args = calls.createEvent[0]?.args;
    assert(!!args, "booking without a number: the invite is still written");
    assert(args !== undefined && !("location" in args && args.location !== undefined), "booking without a number: no location at all");
  }

  // A crashed booking is finished by the drain FROM ITS RESERVATION, so the location
  // has to be in the stored payload, and a row written before this change (no
  // location field) must still resume rather than be refused.
  for (const [label, location] of [
    ["a reservation carrying a number", PHONE],
    ["a reservation written before the location existed", undefined],
  ] as const) {
    const reservation = {
      id: "resv-9",
      idempotency_key: "key-9",
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "slatecafe",
      payload: {
        booking: { ...makeBooking({ id: undefined as unknown as string, gcal_event_id: "slatecafe", idempotency_key: "key-9" }) },
        event: {
          summary: `${TYPE} between Agent A and ${LEAD}`,
          description: "desc",
          start: "2026-06-08T13:00:00.000Z",
          end: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          ...(location ? { location } : {}),
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
    } as unknown as BookingReservation;
    const { deps, calls } = makeDeps({ drainableReservations: [reservation] });
    await processBookingReservations(deps, 15);
    const args = calls.createEvent[0]?.args;
    eq(args?.location, location, `resume of ${label}: the location is what the reservation stored`);
  }

  // --- reschedule, same advisor, the event deleted on Google: recreated --------
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      freeEmails: new Set(["a@x.com"]),
      updateEventTimeGone: true,
    });
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    const args = calls.createEvent[0]?.args;
    eq(args?.summary, `${TYPE} between Agent A and ${LEAD}`, "reschedule recreate: the same advisor is named");
    eq(args?.location, PHONE, "reschedule recreate: with the lead's number");
  }

  // --- reschedule rerouted to ANOTHER advisor: the title names the new one -----
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      candidates: ["b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // A's Monday shift ends 13:30 New York, so 14:00 has to go to B.
      workingHoursByUser: new Map([
        ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 810 }] }],
      ]),
    });
    const res = await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    assert(res.booking.assigned_user_id === "b", "reschedule reroute: the call moved to B (the premise)");
    const args = calls.createEvent[0]?.args;
    eq(args?.summary, `${TYPE} between Agent B and ${LEAD}`, "reschedule reroute: the title names the NEW advisor");
    eq(args?.location, PHONE, "reschedule reroute: with the lead's number");
  }

  // --- reassign: the advisor in the title is the one the call was handed to -----
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    await reassignBooking("bk1", "b@x.com", SYS, deps);
    const args = calls.createEvent[0]?.args;
    eq(args?.summary, `${TYPE} between Owner B and ${LEAD}`, "reassign: the title names the advisor it moved to");
    eq(args?.location, PHONE, "reassign: with the lead's number, which the reassign body does not carry");
  }
  {
    const ctx = { booking: makeBooking({ attendee_phone: null }), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    await reassignBooking("bk1", "b@x.com", SYS, deps);
    const args = calls.createEvent[0]?.args;
    assert(args !== undefined && args.location === undefined, "reassign without a number: no location");
  }

  // --- the lead corrects their details: the invite follows ---------------------
  const contactWorld = (over: Parameters<typeof makeDeps>[0] = {}) => {
    const booking = makeBooking({ manage_token: "tok-c", gcal_event_id: "gcal-1" });
    return makeDeps({ inviteDescription: `Phone: ${PHONE}`, callingNumber: null, ...over, existing: { booking, bucket, eventType } });
  };
  {
    const { deps, calls } = contactWorld();
    await updateBookingContact("tok-c", { name: "Dana Rivera" }, deps);
    const patch = calls.updateEventContact[0]?.patch;
    eq(patch?.summary, `${TYPE} between Agent A and Dana Rivera`, "name corrected: the title keeps the advisor and names the new lead");
    eq(patch?.location, undefined, "name corrected: the location is not touched");
  }
  {
    const { deps, calls } = contactWorld();
    await updateBookingContact("tok-c", { phone: "(215) 555-9999" }, deps);
    const patch = calls.updateEventContact[0]?.patch;
    eq(patch?.location, "+12155559999", "number corrected: the location is the new number as stored");
    eq(patch?.summary, undefined, "number corrected: the title is not touched");
  }
  // The location is SET, never edited, so an invite whose body cannot be read still
  // gets the right number where the advisor looks first.
  {
    const { deps, calls } = contactWorld({ inviteReadThrows: true });
    await updateBookingContact("tok-c", { phone: "(215) 555-9999" }, deps);
    const patch = calls.updateEventContact[0]?.patch;
    eq(patch?.location, "+12155559999", "number corrected, body unreadable: the location still moves");
    eq(patch?.description, undefined, "and the body is not overwritten blind");
  }
  // Control (L1): nothing moved, nothing is sent, so the assertions above are about
  // the correction and not about a patch sent on every save.
  {
    const { deps, calls } = contactWorld();
    await updateBookingContact("tok-c", { name: LEAD, phone: "(203) 561-5295" }, deps);
    eq(calls.updateEventContact.length, 0, "control: retyping the same details rewrites no invite");
  }
}

run().then(() => finish(), (err) => {
  console.error(err);
  process.exit(1);
});

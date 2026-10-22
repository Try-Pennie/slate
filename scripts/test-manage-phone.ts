// A lead corrects the number their advisor will call, from the manage page (#1341).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-manage-phone.ts
//
// The number is the most useful fact on that page and was the only one the lead
// could not change. A mistyped digit, an old mobile, a work line nobody answers:
// the advisor dials, nobody picks up, and it is recorded as a no show.
//
// Three things have to hold, and the third is the one that is easy to ship
// broken: the correction lands, an impossible number is refused by the SAME rule
// the booker applies, and a save that did not commit is never reported as saved.
import { updateBookingContact, updateBookingPhone } from "../src/lib/booking/orchestration.ts";
import { phoneCorrectionUnsentAlert, stalePhoneInviteAlert } from "../src/lib/booking/alert-copy.ts";
import { validateAttendee } from "../src/lib/attendee.ts";
import { US_ONLY_PHONE_NOTICE } from "../src/lib/booking/booker-copy.ts";
import {
  MANAGE_PHONE_NOT_CHANGEABLE,
  MANAGE_PHONE_NOT_FOUND,
} from "../src/lib/booking/manage-copy.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const TOKEN = "tok-manage";

function world(
  overrides: Parameters<typeof makeDeps>[0] = {},
  bookingOverrides: Partial<ReturnType<typeof makeBooking>> = {},
) {
  const booking = makeBooking({
    id: "bk-1",
    manage_token: TOKEN,
    attendee_phone: "+12155550100",
    gcal_event_id: "gcal-1",
    ...bookingOverrides,
  });
  return makeDeps({ ...overrides, existing: { booking, bucket, eventType } });
}

async function run() {
  // --- the correction lands, and the INVITE carries it too -----------------------
  //
  // The row alone is not enough: the advisor reads the number to dial off the
  // calendar invite, so a correction that stops at the database leaves them
  // ringing the digits the lead just told us are wrong.
  {
    const { deps, calls } = world();
    const res = await updateBookingPhone(TOKEN, "2155559999", deps);
    assert(res.ok, `a valid correction is accepted (got ${res.error ?? ""})`);
    assert(
      calls.updateBookingPhone.length === 1 && calls.updateBookingPhone[0].bookingId === "bk-1",
      "the booking's own row is what changed",
    );
    assert(
      calls.updateBookingPhone[0].phone === "+12155559999",
      `stored in the shape the person lookup asks the column for (got ${calls.updateBookingPhone[0].phone})`,
    );
    assert(
      res.phone === "+12155559999",
      "and the STORED number is what comes back, so the page reads what was saved",
    );
    assert(
      calls.updateEventDescription.length === 1,
      "the advisor's invite is rewritten as well as the row",
    );
    assert(
      calls.updateEventDescription[0].description.includes("+12155559999"),
      `the invite body carries the NEW number (got ${calls.updateEventDescription[0].description})`,
    );
    assert(
      !calls.updateEventDescription[0].description.includes("555-0100"),
      "and not the old one",
    );
    assert(
      calls.updateEventDescription[0].description.includes("Reschedule or cancel:"),
      "and the manage link still rides along, because the invite is the lead's only email",
    );
    assert(
      calls.updateEventTime.length === 0,
      "a phone correction never touches the time",
    );
  }

  // --- refused by the SAME rule the booker applies -------------------------------
  //
  // Read from validateAttendee, not restated, so the two cannot drift: a number
  // the booker's field would refuse must not be accepted here, or the product
  // says two different things about one number (L99).
  for (const bad of ["", "215555", "+442071838750", "2155559999 x22"]) {
    const { deps, calls } = world();
    const res = await updateBookingPhone(TOKEN, bad, deps);
    const fromBooker = validateAttendee({ phone: bad }).phone;
    assert(!res.ok, `"${bad}" is refused`);
    assert(
      res.error === fromBooker,
      `"${bad}" gets the booker's own words (got ${res.error}, booker says ${fromBooker})`,
    );
    assert(calls.updateBookingPhone.length === 0, `"${bad}" writes nothing`);
    assert(calls.updateEventDescription.length === 0, `"${bad}" touches no invite`);
  }

  // The two refusals stay DISTINCT: a short number is incomplete, not foreign, and
  // telling that lead about country codes sends them after a problem they do not
  // have (L11). Asserted here because both arrive through one field.
  {
    const { deps } = world();
    const short = await updateBookingPhone(TOKEN, "215555", deps);
    const foreign = await updateBookingPhone(TOKEN, "+442071838750", deps);
    assert(short.error !== foreign.error, "an incomplete number and a foreign one read differently");
    assert(foreign.error === US_ONLY_PHONE_NOTICE, "and the foreign one says which");
  }

  // --- a failed WRITE is never reported as saved (L12) ---------------------------
  //
  // The whole point of the control is that the advisor rings the right number.
  // A save that silently kept the old digits while the page said "saved" would be
  // worse than not offering it at all.
  {
    const { deps, calls } = world({ updateBookingPhoneThrows: true });
    let threw: unknown;
    try {
      await updateBookingPhone(TOKEN, "2155559999", deps);
    } catch (e) {
      threw = e;
    }
    assert(
      threw instanceof Error && /phone|write/i.test(threw.message),
      `a failed write surfaces as an error naming the write (got ${String(threw)})`,
    );
    assert(
      calls.updateEventDescription.length === 0,
      "and the invite is not rewritten off a write that did not land",
    );
  }

  // --- a failed INVITE patch is a different outcome ------------------------------
  //
  // The number IS saved at this point, so telling the lead it failed would push
  // them to retype a number we already hold. The stale invite is an internal
  // repair, and it pages rather than passing in silence (L13).
  {
    const { deps, calls } = world({ updateEventDescriptionThrows: true });
    const res = await updateBookingPhone(TOKEN, "2155559999", deps);
    assert(res.ok, "the lead is told the truth: their number is saved");
    assert(calls.updateBookingPhone.length === 1, "because it really is");
    assert(
      res.staleInvite?.bookingId === "bk-1" && !!res.staleInvite?.agentEmail,
      `the stale invite is REPORTED, naming the calendar to repair (got ${JSON.stringify(res.staleInvite)})`,
    );
    // The words it pages with, read here rather than only in the preview, because
    // the caller must be able to name what is wrong without pasting Google's error.
    const text = stalePhoneInviteAlert(res.staleInvite!.agentEmail, res.staleInvite!.bookingId);
    assert(/old number/i.test(text), "the page says the invite still shows the old number");
    assert(/booking itself is correct/i.test(text), "and that the booking itself is fine");
    assert(!/google|503/i.test(text), "and carries no raw error, which belongs in the logs");
  }

  // --- a booking with no calendar event skips the patch, quietly -----------------
  //
  // Not every booking has an event id (a create whose calendar write failed and is
  // still in the outbox). There is nothing stale to report, so nothing pages: an
  // alert here would cry wolf on a state that is already tracked elsewhere (L36).
  {
    const { deps, calls } = world({}, { gcal_event_id: null });
    const res = await updateBookingPhone(TOKEN, "2155559999", deps);
    assert(res.ok, "the correction still lands");
    assert(calls.updateEventDescription.length === 0, "with no invite to rewrite");
    assert(
      res.staleInvite === undefined,
      "and nothing is reported stale about an invite that does not exist",
    );
  }

  // --- downstream is told about the correction (#1512) ---------------------------
  //
  // Regal and Cadence hold whatever number `booking.created` carried, so a dialer
  // working from that record rings the number the lead just told us is wrong. A
  // correction with a reschedule beside it rides `booking.rescheduled` (#2164, Dan's
  // call 2026-09-10); this control alone is the case nothing was emitted for.
  {
    // The service hands a lead's request a send scheduler (Next after()); this one
    // just runs the work, so the test can see it was handed over.
    const { deps, calls } = world({ deferSend: (work) => void work() });
    const res = await updateBookingPhone(TOKEN, "2155559999", deps);
    assert(res.ok, "the correction lands");
    const sent = calls.webhooks.filter((w) => w.event === "booking.contact_updated");
    assert(sent.length === 1, `exactly one booking.contact_updated is emitted (got ${calls.webhooks.map((w) => w.event).join(",")})`);
    assert(calls.webhooks.length === 1, "and nothing else: no reschedule is implied");
    assert(sent[0].attendee.phone === "+12155559999", `it carries the NEW number (got ${sent[0].attendee.phone})`);
    assert(sent[0].previousPhone === "+12155550100", `and the number it replaced (got ${sent[0].previousPhone})`);
    assert(sent[0].dedupeKey === null, "at least once: every correction is its own event, so no dedupe key could be right");
    assert(sent[0].deferred, "and the POST waits for after the response, like every user facing send");
    assert(res.downstreamUntold === undefined, "and nothing is reported untold");
  }

  // The move's own use of the contact write (#2164) announces nothing itself: its
  // correction rides the booking.rescheduled the move emits, so a second event here
  // would tell Regal one change twice.
  {
    const { deps, calls } = world();
    const res = await updateBookingContact(TOKEN, { phone: "2155559999" }, deps);
    assert(res.ok, "the move's contact write lands");
    assert(calls.webhooks.length === 0, "and emits nothing of its own");
  }

  // Retyping the number already held moves nothing, so nothing is said.
  {
    const { deps, calls } = world();
    const res = await updateBookingPhone(TOKEN, "(215) 555-0100", deps);
    assert(res.ok, "an unchanged number is accepted");
    assert(calls.webhooks.length === 0, "and emits nothing, because nothing changed");
  }

  // A refused number and a failed write tell downstream nothing.
  {
    const { deps, calls } = world();
    await updateBookingPhone(TOKEN, "215555", deps);
    assert(calls.webhooks.length === 0, "a refused number emits nothing");
  }
  {
    const { deps, calls } = world({ updateBookingPhoneThrows: true });
    await updateBookingPhone(TOKEN, "2155559999", deps).catch(() => undefined);
    assert(calls.webhooks.length === 0, "a write that did not land emits nothing");
  }

  // A stale invite does not stop downstream hearing: they are separate repairs.
  {
    const { deps, calls } = world({ updateEventDescriptionThrows: true });
    const res = await updateBookingPhone(TOKEN, "2155559999", deps);
    assert(!!res.staleInvite, "the invite is reported stale");
    assert(
      calls.webhooks.filter((w) => w.event === "booking.contact_updated").length === 1,
      "and the correction is still emitted",
    );
  }

  // #459: a test bucket's booking is recorded but never posted.
  {
    const booking = makeBooking({ id: "bk-1", manage_token: TOKEN, attendee_phone: "+12155550100", gcal_event_id: "gcal-1" });
    const { deps, calls } = makeDeps({ existing: { booking, bucket: { ...bucket, is_test: true }, eventType } });
    await updateBookingPhone(TOKEN, "2155559999", deps);
    assert(calls.webhooks.length === 1 && calls.webhooks[0].suppressed, "a test bucket's correction is recorded suppressed");
  }

  // Failure path: the number IS saved when the emit fails, so the lead is told the
  // truth, and the gap is REPORTED rather than swallowed: nothing retries an event
  // whose delivery row was never written, and the dialer would ring the old number.
  {
    const { deps, calls } = world({ emitWebhookThrows: true });
    const res = await updateBookingPhone(TOKEN, "2155559999", deps);
    assert(res.ok, "the lead is told their number is saved, because it is");
    assert(calls.updateBookingPhone.length === 1, "the row was written");
    assert(
      res.downstreamUntold?.bookingId === "bk-1",
      `the untold correction is reported, naming the booking (got ${JSON.stringify(res.downstreamUntold)})`,
    );
    const text = phoneCorrectionUnsentAlert(res.downstreamUntold!.bookingId);
    assert(/regal still has the old number/i.test(text), "the page says Regal still has the old number");
    assert(/set it as the primary phone/i.test(text), "and names the repair, an action that changes Regal's record (L111)");
    assert(!/\+1215|enqueue|fake refusal/i.test(text), "and carries neither a number nor the raw error");
  }

  // --- an unknown token, and a call that is over ---------------------------------
  //
  // Distinct causes, distinct sentences: a link that resolves to nothing is a
  // different problem from a call that has already happened, and one "could not
  // save" would flatten both.
  {
    const { deps } = makeDeps({ existing: undefined });
    const res = await updateBookingPhone("tok-nope", "2155559999", deps);
    assert(!res.ok && res.error === MANAGE_PHONE_NOT_FOUND, "an unknown token says so");
  }
  for (const status of ["cancelled", "completed"] as const) {
    const { deps, calls } = world({}, { status });
    const res = await updateBookingPhone(TOKEN, "2155559999", deps);
    assert(
      !res.ok && res.error === MANAGE_PHONE_NOT_CHANGEABLE,
      `a ${status} booking has no number left to correct`,
    );
    assert(
      calls.updateBookingPhone.length === 0,
      `and a ${status} booking is not written to (the server gate is the real one)`,
    );
  }
}

run().then(finish);

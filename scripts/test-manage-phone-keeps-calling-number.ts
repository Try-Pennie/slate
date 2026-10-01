// A phone correction on the manage page rewrites the invite's description, and must
// not drop the number the call will come FROM (#1334).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-manage-phone-keeps-calling-number.ts
//
// The reminder lane writes the calling number into the invite once it can read it.
// A lead who then corrects their own number gets the description rebuilt from
// scratch, and a rebuild that did not ask for the calling number would silently
// remove it from the invite for good: no second reminder follows to put it back.
// So the correction asks Salesforce too, and any way of not knowing it leaves the
// line out rather than holding up, or failing, the correction.
import { updateBookingPhone } from "../src/lib/booking/orchestration.ts";
import { bucket, createAsserter, eventType, makeBooking, makeDeps } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();
const TOKEN = "tok-manage";
const LEAD = "00QUi000010889ZMAQ";

function world(
  opts: { callingNumber?: string | null; callingNumberThrows?: boolean; callingNumberHangs?: boolean; leadId?: string | null } = {},
) {
  const booking = makeBooking({
    id: "bk-1",
    manage_token: TOKEN,
    attendee_phone: "+12035615295",
    gcal_event_id: "gcal-1",
    salesforce_id: opts.leadId === undefined ? LEAD : opts.leadId,
    external_id: null,
  });
  return makeDeps({
    existing: { booking, bucket, eventType },
    callingNumber: opts.callingNumber,
    callingNumberThrows: opts.callingNumberThrows,
    callingNumberHangs: opts.callingNumberHangs,
  });
}

async function run() {
  {
    const { deps, calls } = world({ callingNumber: "+12197588170" });
    const res = await updateBookingPhone(TOKEN, "(215) 555-9999", deps);
    assert(res.ok, "the correction is accepted");
    assert(calls.readCallingNumber.length === 1 && calls.readCallingNumber[0] === LEAD, "Salesforce is asked about this booking's lead");
    const description = calls.updateEventContact[0]?.patch.description ?? "";
    assert(description.includes("+12155559999"), "the invite carries the corrected number for the advisor");
    assert(description.includes("(219) 758-8170"), "and keeps the number the call will come from");
  }
  {
    const { deps, calls } = world({ callingNumber: null });
    const res = await updateBookingPhone(TOKEN, "(215) 555-9999", deps);
    assert(res.ok, "with no calling number known the correction still goes through");
    const description = calls.updateEventContact[0]?.patch.description ?? "";
    assert(!/come from/i.test(description), "and the invite says nothing about a calling number");
  }
  {
    const { deps, calls } = world({ callingNumberThrows: true });
    const res = await updateBookingPhone(TOKEN, "(215) 555-9999", deps);
    assert(res.ok, "a failed Salesforce read never fails the lead's correction");
    const description = calls.updateEventContact[0]?.patch.description ?? "";
    assert(description.includes("+12155559999") && !/come from/i.test(description), "the invite is written without the line");
  }
  {
    // A Salesforce that never answers must not stall the lead's own correction: it is
    // bounded by the same deadline the manage page uses, and the invite goes without
    // the line. The deadline timer fires at once here, so no test waits for real.
    const { deps, calls } = world({ callingNumberHangs: true });
    const res = await updateBookingPhone(TOKEN, "(215) 555-9999", deps);
    assert(res.ok, "a Salesforce that never answers does not hold the correction");
    const description = calls.updateEventContact[0]?.patch.description ?? "";
    assert(description.includes("+12155559999") && !/come from/i.test(description), "the invite is written without the line");
    assert(calls.deadlineTimers.set === 1 && calls.deadlineTimers.cleared === 1, "under one deadline, whose timer is cleared");
  }
  {
    // A correction that changes nothing writes nothing, so it asks nothing either.
    const { deps, calls } = world({ callingNumber: "+12197588170" });
    await updateBookingPhone(TOKEN, "(203) 561-5295", deps);
    assert(calls.readCallingNumber.length === 0, "an unchanged number costs no Salesforce read");
  }
}

await run();
finish();

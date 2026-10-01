// A phone correction on the manage page edits the invite's description IN PLACE, and
// never drops the number the call will come FROM (#1334).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-manage-phone-keeps-calling-number.ts
//
// The reminder lane writes the calling number into the invite once it can read it.
// A lead who then corrects their own number used to get the description rebuilt from
// scratch, so any way of not reading the calling number again (a refusal, a timeout,
// an empty field) silently removed the line for good: no second reminder follows to
// put it back. So the correction reads what the invite says NOW and changes only the
// phone line, and the calling number line only when Salesforce answered with one.
// Everything else on the invite, the reassign explanation (#969) included, survives.
import { updateBookingContact, updateBookingPhone } from "../src/lib/booking/orchestration.ts";
import { bucket, eventType, makeBooking, makeDeps } from "./lib/booking-fakes.ts";
import { assert, eq, finish } from "./lib/harness.ts";
const TOKEN = "tok-manage";
const LEAD = "00QUi000010889ZMAQ";
const LINK = "Reschedule or cancel: https://slate.test/booking/manage/tok-manage";
const FROM_219 = "The call will come from (219) 758-8170. Save it to your contacts so your phone lets it through.";
/** The invite after the reminder lane wrote the calling number into it. */
const WITH_LINE = `Booked via Pennie. Phone: +12035615295\n${FROM_219}\n${LINK}`;

function world(
  opts: {
    callingNumber?: string | null;
    callingNumberThrows?: boolean;
    callingNumberHangs?: boolean;
    inviteDescription?: string | null;
    inviteReadThrows?: boolean;
  } = {},
) {
  const booking = makeBooking({
    id: "bk-1",
    manage_token: TOKEN,
    attendee_phone: "+12035615295",
    gcal_event_id: "gcal-1",
    salesforce_id: LEAD,
    external_id: null,
  });
  return makeDeps({
    existing: { booking, bucket, eventType },
    callingNumber: opts.callingNumber,
    callingNumberThrows: opts.callingNumberThrows,
    callingNumberHangs: opts.callingNumberHangs,
    inviteDescription: opts.inviteDescription === undefined ? WITH_LINE : opts.inviteDescription,
    inviteReadThrows: opts.inviteReadThrows,
  });
}

const written = (calls: ReturnType<typeof world>["calls"]) => calls.updateEventContact[0]?.patch.description ?? "";

async function run() {
  // A known number: the phone line moves, the calling line stays (or is updated).
  {
    const { deps, calls } = world({ callingNumber: "+12197588170" });
    const res = await updateBookingPhone(TOKEN, "(215) 555-9999", deps);
    assert(res.ok, "the correction is accepted");
    assert(calls.readCallingNumber[0] === LEAD, "Salesforce is asked about this booking's lead");
    eq(written(calls), `Booked via Pennie. Phone: +12155559999\n${FROM_219}\n${LINK}`, "only the phone line changed");
  }
  {
    const { deps, calls } = world({ callingNumber: "+13025550100" });
    await updateBookingPhone(TOKEN, "(215) 555-9999", deps);
    const d = written(calls);
    assert(d.includes("(302) 555-0100") && !d.includes("(219)"), "a changed calling number replaces the old line");
  }

  // Every way of NOT knowing the number keeps the line the lane already wrote.
  for (const [label, opts] of [
    ["an empty field", { callingNumber: null }],
    ["a refused read", { callingNumberThrows: true }],
    ["a read that never answers", { callingNumberHangs: true }],
  ] as const) {
    const { deps, calls } = world(opts);
    const res = await updateBookingPhone(TOKEN, "(215) 555-9999", deps);
    assert(res.ok, `${label}: the correction still goes through`);
    eq(written(calls), `Booked via Pennie. Phone: +12155559999\n${FROM_219}\n${LINK}`, `${label}: the calling number line is kept`);
  }
  {
    const { deps, calls } = world({ callingNumberHangs: true });
    await updateBookingPhone(TOKEN, "(215) 555-9999", deps);
    assert(calls.deadlineTimers.set === 1 && calls.deadlineTimers.cleared === 1, "the hung read ran under one deadline, whose timer is cleared");
  }

  // Text the booking path did not write survives the edit.
  {
    const reassign =
      "Your appointment time has not changed. You have been matched with a different Pennie advisor who will be with you at this time. There is nothing you need to do.";
    const { deps, calls } = world({ inviteDescription: `${reassign}\n${FROM_219}`, callingNumber: null });
    await updateBookingPhone(TOKEN, "(215) 555-9999", deps);
    const d = written(calls);
    assert(d.includes(reassign), "the reassign explanation is kept word for word");
    assert(d.includes("Phone: +12155559999"), "and the corrected number is added for the advisor");
    assert(d.includes(FROM_219), "and the calling number line is kept");
  }

  // An invite that cannot be read is never overwritten blind: the save stands and the
  // stale invite is reported, exactly as a failed invite write is.
  {
    const { deps, calls } = world({ inviteReadThrows: true, callingNumber: "+12197588170" });
    const res = await updateBookingPhone(TOKEN, "(215) 555-9999", deps);
    assert(res.ok, "the lead's correction is still saved");
    assert(calls.updateEventContact.length === 0, "nothing is written to an invite nobody could read");
    assert(!!(res as { staleInvite?: unknown }).staleInvite, "and the stale invite is reported");
  }

  // The description read must not take the REST of the correction down with it: a
  // name or email corrected together with the phone still reaches Google when the
  // description cannot be read, and only the description is left as it was.
  for (const [label, opts] of [
    ["an invite that cannot be read", { inviteReadThrows: true }],
    ["an invite that is gone", { inviteDescription: null }],
  ] as const) {
    const { deps, calls } = world({ ...opts, callingNumber: "+12197588170" });
    const res = await updateBookingContact(
      TOKEN,
      { name: "Dana Rivera", email: "dana.new@example.com", phone: "(215) 555-9999" },
      deps,
    );
    assert(res.ok, `${label}: the correction is saved`);
    const patch = calls.updateEventContact[0]?.patch;
    assert(calls.updateEventContact.length === 1, `${label}: the other fields are still sent to the invite`);
    assert(!!patch?.summary && patch.summary.includes("Dana Rivera"), `${label}: with the new name in the title`);
    assert(patch?.attendeeEmail === "dana.new@example.com", `${label}: and the new address invited`);
    assert(patch?.description === undefined, `${label}: and the description left untouched`);
    assert(!!(res as { staleInvite?: unknown }).staleInvite, `${label}: and the stale description reported`);
  }

  // A correction that changes nothing writes nothing, so it asks nothing either.
  {
    const { deps, calls } = world({ callingNumber: "+12197588170" });
    await updateBookingPhone(TOKEN, "(203) 561-5295", deps);
    assert(calls.readCallingNumber.length === 0, "an unchanged number costs no Salesforce read");
  }
}

await run();
finish();

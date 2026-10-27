// The coordinator booking page's rules (#4205), as one pure reducer the page only sends
// events to, and the view it draws from (src/lib/coordinator/booking-page.ts).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coordinator-booking-page.ts
//
// The settled design's decisions a reducer can prove are proved here, by the same events
// the page sends: find on paste (D22), the checkbox that locks the whole booking card
// (D10) and the pointer a press on it raises (D11), only bookable times (D15), the day
// row (D12, D13), the reason and its detail (D18), the refused main button and its note
// (D19), the confirmation dialog (D23 to D26), a booking placed once (D30), and the done
// state (D27 to D29). Every value is invented.
import { DateTime } from "luxon";
import {
  initialPageState,
  pageView,
  placeRequest,
  reducePage,
  zoneNames,
  type LookupAnswer,
  type PageEvent,
  type PageState,
  type PlaceAnswer,
} from "../src/lib/coordinator/booking-page.ts";
import { COORDINATOR_PAGE_COPY as COPY } from "../src/lib/coordinator/booking-page-copy.ts";
import { offeredDays } from "../src/lib/coordinator/bookable-hours.ts";
import type { BusinessHoursRules } from "../src/lib/availability/compute.ts";
import type { Customer } from "../src/lib/coordinator/customer.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// Pennie open 08:00 to 19:30 Eastern on weekdays, judged as start times (a call of no
// length), which is how the design gives its hours. Monday, November 16, 12:40pm Eastern.
const HOURS: BusinessHoursRules = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 19 * 60 + 30 })),
  exceptions: [],
};
const NOW = Date.parse("2026-11-16T17:40:00Z");
const ID = "00Q5e00000XyZ12EAC";
const REASONS = [
  { code: "schedule_conflict", label: "Schedule conflict" },
  { code: "found_better_time", label: "Found a better time" },
  { code: "need_more_prep", label: "Need more time to prepare" },
  { code: "other", label: "Other" },
];
const ctx = { nowMs: NOW, reasons: REASONS };

function customer(over: Partial<Customer> = {}): Customer {
  return {
    salesforceLeadId: ID,
    name: "Jordan Rivera",
    firstName: "Jordan",
    email: "jordan@example.com",
    phone: "+1 (555) 010 2477",
    zone: "America/Phoenix",
    zoneFrom: "zip",
    bucketCode: "412",
    bucketSource: "salesforce",
    bucketIsTest: false,
    durationMin: 30,
    ...over,
  };
}
const days = (zone: string) => ({ ok: true as const, days: offeredDays({ hours: HOURS, zone, durationMin: 0, nowMs: NOW, horizonDays: 4 }) });
const existing = {
  kind: "found" as const,
  happens: "moves-when-confirmed" as const,
  call: { bookingId: "bk-old", startsAt: "2026-11-17T18:00:00.000Z", timezone: "America/Phoenix", advisorName: "Ada Example", onPlaceholder: false },
};
const jordan: LookupAnswer = { ok: true, customer: customer(), existingCall: existing, days: days("America/Phoenix") };
const sam: LookupAnswer = {
  ok: true,
  customer: customer({ salesforceLeadId: "00Q5e00000Qr7Ok4AF", name: "Sam Okafor", firstName: "Sam", zone: "America/Los_Angeles" }),
  existingCall: { kind: "none" },
  days: days("America/Los_Angeles"),
};

const run = (events: PageEvent[], from: PageState = initialPageState()) => events.reduce(reducePage, from);
const found = (answer: LookupAnswer, more: PageEvent[] = []) =>
  run([{ type: "leadEdited", value: answer.ok ? answer.customer.salesforceLeadId : ID, at: NOW }, { type: "lookupAnswered", seq: 1, answer }, ...more]);
const thursday2pm = "2026-11-19T14:00:00.000-07:00";

// --- find on paste (D22), and a reference that is not a Lead (D31) ---------------------
{
  const s = run([{ type: "leadEdited", value: `https://pennie.lightning.force.com/lightning/r/Lead/${ID}/view`, at: NOW }]);
  eq([s.phase, s.lookup.seq, s.lookup.leadId], ["finding", 1, ID], "pasting a whole Lead link looks the customer up with no press");
  const partial = run([{ type: "leadEdited", value: "00Q5e00000", at: NOW }]);
  eq([partial.phase, partial.lookup.seq, partial.refusal], ["idle", 0, null], "a part of an id is not looked up, and not refused while typing");
  const pressed = reducePage(partial, { type: "findPressed", at: NOW });
  eq(pressed.refusal, COPY.lead.notALeadId, "Find on a reference that is not a Lead says so under the field");
  eq(pageView(pressed, ctx).lead.refusal, COPY.lead.notALeadId, "and the view draws it");
  const again = reducePage(found(jordan), { type: "leadEdited", value: ID, at: NOW });
  eq(again.lookup.seq, 1, "the customer already on the page is not looked up again by a paste");
  const busy = reducePage(run([{ type: "leadEdited", value: ID, at: NOW }]), { type: "findPressed", at: NOW });
  eq(busy.lookup.seq, 1, "Find while a lookup is running starts nothing");
  const stale = reducePage(run([{ type: "leadEdited", value: ID, at: NOW }]), { type: "lookupAnswered", seq: 7, answer: jordan });
  eq(stale.phase, "finding", "an answer to a lookup that is not the latest is ignored");
  const refused = reducePage(run([{ type: "leadEdited", value: ID, at: NOW }]), { type: "lookupAnswered", seq: 1, answer: { ok: false, sentence: COPY.lead.noSuchLead } });
  eq([refused.phase, refused.refusal], ["idle", COPY.lead.noSuchLead], "a refused lookup says the server's sentence under the field");
  const silent = reducePage(run([{ type: "leadEdited", value: ID, at: NOW }]), { type: "lookupNoAnswer", seq: 1 });
  eq([silent.phase, silent.refusal], ["idle", COPY.more.lookupNoAnswer], "a lookup that never answered says so, and Find tries again");
}

// --- the customer (D5 to D8) ---------------------------------------------------------
{
  const v = pageView(found(jordan), ctx);
  eq(v.customer, { name: "Jordan Rivera", phone: "+1 (555) 010 2477", zone: "Arizona (Phoenix)", clock: "It's 10:40am for Jordan right now." },
    "name, phone, the zone named once, and the customer's clock now");
  eq(zoneNames("America/Phoenix"), { name: "Arizona (Phoenix)", spoken: "Arizona time (Phoenix)" }, "Arizona as listed and as read back");
  eq(zoneNames("America/Los_Angeles"), { name: "Pacific (Los Angeles)", spoken: "Pacific time (Los Angeles)" }, "Pacific");
  eq(zoneNames("America/Boise"), { name: "Boise", spoken: "Boise time" }, "an unlisted zone reads as its city");
  const nameless = pageView(found({ ...jordan, customer: customer({ firstName: null, phone: null }) } as LookupAnswer), ctx);
  eq([nameless.customer?.phone, nameless.customer?.clock], [COPY.more.noPhone, "It's 10:40am for the customer right now."], "a Lead with no first name or phone still reads");
}

// --- the existing call locks the whole card until the box is checked (D3, D10, D11) ----
{
  const locked = found(jordan);
  const v = pageView(locked, ctx);
  eq(v.notice?.heading, "Jordan already has a call", "the notice names the customer");
  eq(v.notice?.lines, ["It is on Tuesday, November 17 at 11:00am with Ada Example. If you book a new time, this call moves to the new time."], "and the call, with no zone");
  eq(v.notice?.told?.label, "I told Jordan their Tuesday call will move", "with the checkbox");
  assert(v.booking!.locked && v.booking!.days.every((d) => d.disabled) && v.booking!.reason!.disabled && v.booking!.confirm.refused, "every control on the card is off");
  eq(v.booking!.line, { text: "Check the box above after you tell Jordan.", tone: "muted" }, "and the hours line says what unlocks it");
  eq(v.booking!.overlay, null, "no pointer before a press");
  const tried = ["dayChosen", "timeChosen", "reasonChosen"].map((type) =>
    reducePage(locked, { type, date: "2026-11-19", start: thursday2pm, code: "schedule_conflict" } as PageEvent));
  assert(tried.every((t) => t.day === null && t.start === null && t.reason === null), "a choice on the locked card changes nothing");
  const pressed = reducePage(locked, { type: "lockedAttempt" });
  eq(pageView(pressed, ctx).booking!.overlay, COPY.warning.overlay, "a press on the locked card puts the pointer over it");
  eq(pageView(pressed, ctx).live, "You cannot book yet. First check the box that says you told Jordan their Tuesday call will move.", "and says why, politely");
  assert(pageView(reducePage(pressed, { type: "lockedAttempt" }), ctx).live !== pageView(pressed, ctx).live, "a second press says it again (the region's text changes)");
  const open = reducePage(pressed, { type: "toldChanged", checked: true });
  assert(!pageView(open, ctx).booking!.locked && pageView(open, ctx).booking!.overlay === null && pageView(open, ctx).live === "", "checking unlocks it and takes the pointer away");
  const chosen = run([{ type: "dayChosen", date: "2026-11-19" }, { type: "timeChosen", start: thursday2pm }, { type: "reasonChosen", code: "schedule_conflict" }, { type: "toldChanged", checked: false }], open);
  eq([chosen.day, chosen.start, chosen.reason, pageView(chosen, ctx).booking!.locked], ["2026-11-19", thursday2pm, "schedule_conflict", true], "unchecking locks it again and keeps what was entered");
}

// --- the day row and the times (D9, D12 to D16) ----------------------------------------
{
  const v = pageView(found(sam), ctx);
  eq(v.booking!.days.map((d) => d.label), ["Monday, November 16, Today", "Tuesday, November 17", "Wednesday, November 18", "Thursday, November 19"], "today through the last day Slate offers");
  eq(v.booking!.days.map((d) => [d.top, d.num, d.bottom]), [["Today", "16", "Nov"], ["Tomorrow", "17", "Nov"], ["Wed", "18", "Nov"], ["Thu", "19", "Nov"]], "each chip as the booker draws it");
  eq(v.booking!.line, { text: COPY.newTime.pickDay, tone: "muted" }, "before a day, the line asks for one");
  eq([v.booking!.times.morning.length, v.booking!.times.afternoon.length, v.booking!.times.disabled], [0, 0, true], "Time is there, unusable, before a day");
  eq([v.booking!.confirm.label, v.booking!.confirm.refused, v.booking!.reason], [COPY.newTime.bookIdle, true, null], "a new booking's confirm, refused, and no reason asked");

  const thu = pageView(run([{ type: "toldChanged", checked: true }, { type: "dayChosen", date: "2026-11-19" }], found(jordan)), ctx);
  eq(thu.booking!.line, { text: "On Thursday, November 19, calls can start from 8:00am to 5:30pm.", tone: "fg" }, "the chosen day's first and last start");
  const all = [...thu.booking!.times.morning, ...thu.booking!.times.afternoon].map((t) => t.label);
  eq([all.length, all[0], all.at(-1)], [39, "8:00am", "5:30pm"], "every quarter hour inside Pennie's hours and the calling window, nothing else");
  assert(thu.booking!.times.morning.every((t) => t.label.endsWith("am")) && thu.booking!.times.afternoon.every((t) => t.label.endsWith("pm")), "grouped Morning and Afternoon");
  const today = pageView(reducePage(found(sam), { type: "dayChosen", date: "2026-11-16" }), ctx);
  eq(today.booking!.times.morning[0]?.label, "9:45am", "today only offers the times still ahead of now");

  const lateNow = Date.parse("2026-11-17T00:45:00Z"); // Monday 7:45pm Eastern
  const late: LookupAnswer = { ...jordan, days: { ok: true, days: offeredDays({ hours: HOURS, zone: "America/Phoenix", durationMin: 0, nowMs: lateNow, horizonDays: 4 }) } };
  const lv = pageView(found(late, [{ type: "toldChanged", checked: true }]), { ...ctx, nowMs: lateNow });
  eq([lv.booking!.days[0]?.disabled, lv.booking!.days[0]?.bottom, lv.booking!.days[0]?.label, lv.booking!.days.at(-1)?.label],
    [true, "Closed", "Monday, November 16, Today, Closed", "Friday, November 20"], "Monday evening: today closed, the row runs to Friday");
  const closed = reducePage(found(late, [{ type: "toldChanged", checked: true }]), { type: "dayChosen", date: "2026-11-16" });
  eq(closed.day, null, "a closed day cannot be chosen");
  const keep = run([{ type: "dayChosen", date: "2026-11-18" }, { type: "timeChosen", start: "2026-11-18T10:00:00.000-08:00" }, { type: "dayChosen", date: "2026-11-19" }], found(sam));
  eq(keep.start, null, "a time from another day does not survive a change of day");
  const bad = reducePage(reducePage(found(sam), { type: "dayChosen", date: "2026-11-19" }), { type: "timeChosen", start: "2026-11-19T21:00:00.000-08:00" });
  eq(bad.start, null, "a time the day does not offer cannot be chosen");
}

// --- the reason, its detail, and the refused confirm (D5, D18, D19) --------------------
{
  const ready = run([{ type: "toldChanged", checked: true }, { type: "dayChosen", date: "2026-11-19" }, { type: "timeChosen", start: thursday2pm }], found(jordan));
  const v = pageView(ready, ctx);
  eq([v.booking!.reason?.value, v.booking!.reason?.placeholder], [null, "Choose a reason"], "the reason starts empty");
  eq([v.booking!.confirm.label, v.booking!.confirm.refused, v.booking!.confirm.note], ["Move the call to Thursday, November 19 at 2:00pm", true, COPY.newTime.reasonNeeded], "a move with no reason is refused, and says why");
  const other = reducePage(ready, { type: "reasonChosen", code: "other" });
  eq([pageView(other, ctx).booking!.detail?.label, pageView(other, ctx).booking!.confirm.note], [COPY.newTime.detailLabel, COPY.newTime.detailNeeded], "Other opens What happened, and the confirm waits for it");
  const spaces = reducePage(other, { type: "detailEdited", value: "   " });
  assert(pageView(spaces, ctx).booking!.confirm.refused, "spaces are not a reason");
  const written = reducePage(other, { type: "detailEdited", value: "Customer at work" });
  eq([pageView(written, ctx).booking!.confirm.refused, pageView(written, ctx).booking!.confirm.note], [false, null], "text in it lets the confirm go");
  const back = reducePage(written, { type: "reasonChosen", code: "schedule_conflict" });
  eq([pageView(back, ctx).booking!.detail, back.detail], [null, "Customer at work"], "another reason hides the box and keeps the text");
  eq(reducePage(other, { type: "detailEdited", value: "x".repeat(600) }).detail.length, 500, "the detail is held to its limit");
  eq(reducePage(ready, { type: "confirmPressed" }).confirming, false, "a refused confirm opens nothing");
}

// --- the dialog, placing once, and the done state (D23 to D30) ---------------------------
{
  const ready = run([{ type: "toldChanged", checked: true }, { type: "dayChosen", date: "2026-11-19" }, { type: "timeChosen", start: thursday2pm }, { type: "reasonChosen", code: "schedule_conflict" }], found(jordan));
  const asking = reducePage(ready, { type: "confirmPressed" });
  const d = pageView(asking, ctx).dialog!;
  eq([d.title, d.when, d.moves, d.back, d.go], ["Move Jordan Rivera's call?", "Thursday, November 19 at 2:00pm, Arizona time (Phoenix)", "Moves Jordan's Tuesday, November 17 at 11:00am call", "Go back", "Move the call"],
    "the dialog reads the move back, the zone written out");
  eq(reducePage(asking, { type: "dialogClosed" }).confirming, false, "Go back or Escape closes it");
  eq(placeRequest(asking), null, "nothing is placed by opening it");

  const placing = reducePage(asking, { type: "placePressed", submissionId: "sub-1", at: NOW });
  eq([placing.phase, placing.place.seq, pageView(placing, ctx).dialog?.placing], ["placing", 1, true], "only its main button places the call, and shows it is working");
  eq(placeRequest(placing), { reference: ID, startIso: thursday2pm, submissionId: "sub-1", move: { bookingId: "bk-old", reasonCode: "schedule_conflict", reasonDetail: "" } }, "the move, by the customer's Lead");
  const twice = reducePage(placing, { type: "placePressed", submissionId: "sub-2", at: NOW });
  eq([twice.place.seq, twice.submissionId], [1, "sub-1"], "a second press while placing does nothing");
  eq(reducePage(placing, { type: "dialogClosed" }).confirming, true, "and the dialog cannot be closed while placing");

  const noAnswer = reducePage(placing, { type: "placeNoAnswer", seq: 1 });
  eq([noAnswer.phase, noAnswer.confirming, pageView(noAnswer, ctx).booking!.confirm.failure], ["found", false, COPY.more.placeNoAnswer], "no answer says it may or may not have booked");
  const retry = run([{ type: "confirmPressed" }, { type: "placePressed", submissionId: "sub-9", at: NOW }], noAnswer);
  eq(retry.submissionId, "sub-1", "a retry goes under the same submission id, so the call is booked once (D30)");

  const moved: PlaceAnswer = { kind: "moved", on: "advisor", advisorName: "Ada Example", startsAt: "2026-11-19T21:00:00.000Z", sentence: "" };
  const done = reducePage(placing, { type: "placeAnswered", seq: 1, outcome: moved });
  const v = pageView(done, ctx);
  eq([v.done, v.customer, v.booking, v.dialog],
    [{ heading: "Moved", when: "Thursday, November 19 at 2:00pm", with: "With Ada Example.", link: "Jordan's booking link still works.", by: "Moved by you", again: "Book another call" }, null, null, null],
    "once moved, only the done state is left");
  eq(reducePage(done, { type: "placeAnswered", seq: 1, outcome: moved }).phase, "done", "a late duplicate answer changes nothing");
  eq(reducePage(done, { type: "again" }), initialPageState(), "Book another call clears the page");

  const samReady = run([{ type: "dayChosen", date: "2026-11-17" }, { type: "timeChosen", start: "2026-11-17T16:00:00.000-08:00" }, { type: "confirmPressed" }], found(sam));
  const sd = pageView(samReady, ctx).dialog!;
  eq([sd.title, sd.when, sd.moves, sd.go], ["Book this call for Sam Okafor?", "Tuesday, November 17 at 4:00pm, Pacific time (Los Angeles)", null, "Book the call"], "a new booking's dialog says nothing about a move");
  const samPlacing = reducePage(samReady, { type: "placePressed", submissionId: "sub-3", at: NOW });
  eq(placeRequest(samPlacing)?.move, undefined, "and sends no move");
  const marcia = pageView(reducePage(samPlacing, { type: "placeAnswered", seq: 1, outcome: { kind: "booked", on: "placeholder", advisorName: "Marcia", startsAt: "2026-11-18T00:00:00.000Z", sentence: "" } }), ctx);
  eq([marcia.done?.heading, marcia.done?.with, marcia.done?.link, marcia.done?.by], ["Booked", "With Marcia, Pennie's AI agent. No advisor was free at this time, so Marcia will text Sam.", null, "Booked by you"], "Marcia is named only once it is booked on her");
  const refused = reducePage(samPlacing, { type: "placeAnswered", seq: 1, outcome: { kind: "refused", sentence: "That time has already passed. Pick a later one." } });
  eq([refused.phase, refused.confirming, pageView(refused, ctx).booking!.confirm.failure], ["found", false, "That time has already passed. Pick a later one."], "a refusal is said on the page, in the server's words");
  const surprise = reducePage(samPlacing, { type: "placeAnswered", seq: 1, outcome: { kind: "needs-confirm", call: existing.call, sentence: "" } });
  assert(pageView(surprise, ctx).booking!.locked && pageView(surprise, ctx).notice?.told !== undefined, "a call found at booking time locks the card behind the box");
  eq(pageView(surprise, ctx).booking!.confirm.failure, "Sam already has a call, so nothing was booked. Check the box above after you tell Sam, then try again.", "and says nothing was booked");
}

// --- calls the page cannot move, and hours it cannot read ------------------------------
{
  const loose: LookupAnswer = { ...jordan, existingCall: { kind: "found", happens: "refused-loose-match", matchedOn: "email-or-phone", call: existing.call } };
  const lv = pageView(found(loose), ctx);
  eq([lv.notice?.heading, lv.notice?.told, lv.booking!.locked], ["Jordan may already have a call", undefined, true], "a call matching only on email or phone locks the card with no box to unlock it");
  const unreadable = pageView(found({ ...jordan, existingCall: { kind: "unreadable" } }), ctx);
  eq([unreadable.notice?.heading, unreadable.booking!.locked, unreadable.booking!.reason], ["We could not check if Jordan already has a call", false, null], "an unreadable call check is said, and booking goes ahead as new");
  const noHours = pageView(found({ ...sam, days: { ok: false, reason: "hours-unreadable" } }), ctx);
  eq([noHours.booking!.line, noHours.booking!.days.length], [{ text: COPY.more.daysUnreadable, tone: "error" }, 0], "unreadable hours are said, never a row of closed days");
}

// --- the clock line follows a real clock, the day labels follow the customer's day -------
{
  const later = pageView(found(sam), { ...ctx, nowMs: NOW + 65 * 60_000 });
  eq(later.customer?.clock, "It's 10:45am for Sam right now.", "the customer's clock moves with now");
  eq(DateTime.fromMillis(NOW, { zone: "America/Los_Angeles" }).toFormat("HH:mm"), "09:40", "positive control: Sam's clock at the fixed now");
}

finish();

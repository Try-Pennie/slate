// The 1 hour reminder email (#4282): which bookings are due one, and what it says.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-hour-reminder.ts
//
// The second reminder email, beside the 24 hour one (#2359). Leads lost cal.com's 1
// hour email at cutover; Regal's 1 hour text stayed, and this sits next to it.
//
// The rules Dan settled on 2026-10-27:
//   * a booking made less than an hour before the call gets no 1 hour email, since the
//     invite and the confirmation text have only just arrived;
//   * no 1 hour email when the first reminder went out in the last two hours, so a
//     booking made a few hours ahead is not emailed twice back to back.
import {
  HOUR_REMINDER_LEAD_MS,
  HOUR_REMINDER_GAP_MS,
  HOUR_REMINDER_MIN_LEAD_MS,
  reminderDue,
  hourReminderDue,
  hourReminderSubject,
  hourReminderBody,
  reminderBody,
} from "../src/lib/booking/reminder.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Em/en dash detector built from escapes, so this file holds no literal dash. */
const DASHES = new RegExp("[\\u2013\\u2014]");

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 27, 14, 0, 0);

/** A call 55 minutes out, booked two days ago and reminded the day before. */
const booking = (over: Partial<Parameters<typeof hourReminderDue>[0]> = {}) => ({
  startsAtMs: NOW + 55 * MIN,
  createdAtMs: NOW - 48 * HOUR,
  status: "confirmed" as string,
  hourReminderSentForMs: null as number | null,
  dayReminderSentForMs: NOW + 55 * MIN as number | null,
  dayReminderSentAtMs: NOW - 23 * HOUR as number | null,
  ...over,
});

// --- the window ----------------------------------------------------------------
{
  eq(HOUR_REMINDER_LEAD_MS, HOUR, "the email goes out an hour before the call");
  assert(hourReminderDue(booking(), NOW), "a call inside the hour with no 1 hour email recorded is due");
  assert(hourReminderDue(booking({ startsAtMs: NOW + HOUR, dayReminderSentForMs: NOW + HOUR }), NOW), "the mark itself is due");
  assert(
    !hourReminderDue(booking({ startsAtMs: NOW + HOUR + 1, dayReminderSentForMs: NOW + HOUR + 1 }), NOW),
    "one millisecond before the mark is not",
  );
  assert(!hourReminderDue(booking({ startsAtMs: NOW }), NOW), "a call starting now is not reminded");
  assert(!hourReminderDue(booking({ startsAtMs: NOW - MIN }), NOW), "nor one already under way");
}

// --- never when the call is too close (#4287, Dan 2026-10-27) ----------------------
//
// With no lower bound, the first run after the deploy emailed every call in the next
// hour at once, one of them minutes before it started. The same follows any stretch
// the job stops and then catches up. Under half an hour the 15 minute text covers it.
{
  eq(HOUR_REMINDER_MIN_LEAD_MS, 30 * MIN, "no 1 hour email under thirty minutes before the call");
  const at = (mins: number) => booking({ startsAtMs: NOW + mins * MIN, dayReminderSentForMs: NOW + mins * MIN });
  assert(hourReminderDue(at(30), NOW), "thirty minutes out is still sent");
  assert(!hourReminderDue(booking({ startsAtMs: NOW + 30 * MIN - 1, dayReminderSentForMs: NOW + 30 * MIN - 1 }), NOW), "one millisecond under is not");
  assert(!hourReminderDue(at(5), NOW), "a call five minutes away gets no 1 hour email");
}

// --- once per start, and a moved call earns a fresh one --------------------------
{
  const start = NOW + 55 * MIN;
  assert(!hourReminderDue(booking({ hourReminderSentForMs: start }), NOW), "a start already reminded is not reminded again");
  assert(
    hourReminderDue(booking({ hourReminderSentForMs: start + 2 * HOUR }), NOW),
    "a call that moved since its 1 hour email gets one for its new time",
  );
}

// --- only live bookings ---------------------------------------------------------
{
  assert(!hourReminderDue(booking({ status: "cancelled" }), NOW), "a cancelled call gets nothing");
  assert(hourReminderDue(booking({ status: "rescheduled" }), NOW), "a rescheduled one is still a live call");
}

// --- a booking made inside the last hour gets none (Dan, 2026-10-27) -------------
{
  const start = NOW + 50 * MIN;
  assert(
    !hourReminderDue(booking({ startsAtMs: start, createdAtMs: start - 40 * MIN, dayReminderSentForMs: null, dayReminderSentAtMs: null }), NOW),
    "a call booked forty minutes before it starts gets no 1 hour email",
  );
  assert(
    hourReminderDue(booking({ startsAtMs: start, createdAtMs: start - HOUR, dayReminderSentForMs: null, dayReminderSentAtMs: null }), NOW),
    "a call booked exactly an hour ahead is not a late booking",
  );
}

// --- not straight after the first reminder (Dan, 2026-10-27) --------------------
//
// A booking made a few hours ahead has its first reminder sent about ten minutes after
// it is made (the hand-back hold), so without this the lead gets two emails close
// together. The gap is measured from when the first one was SENT.
{
  eq(HOUR_REMINDER_GAP_MS, 2 * HOUR, "the two emails are at least two hours apart");
  const start = NOW + 55 * MIN;
  assert(
    !hourReminderDue(booking({ dayReminderSentAtMs: NOW - 110 * MIN }), NOW),
    "a first reminder sent an hour and fifty minutes ago holds the 1 hour email back",
  );
  assert(
    hourReminderDue(booking({ dayReminderSentAtMs: NOW - 2 * HOUR }), NOW),
    "one sent two hours ago does not",
  );
  assert(
    !hourReminderDue(booking({ dayReminderSentAtMs: NOW }), NOW),
    "one sent this very tick holds it back, so a call moved close in gets one email, not two",
  );
  // The first reminder only counts if it was about THIS start: one sent recently about
  // a time the call no longer holds told the lead the wrong time.
  assert(
    hourReminderDue(booking({ dayReminderSentForMs: start + 3 * HOUR, dayReminderSentAtMs: NOW - 30 * MIN }), NOW),
    "a recent first reminder about the call's OLD time does not hold the 1 hour email back",
  );
  assert(
    hourReminderDue(booking({ dayReminderSentForMs: null, dayReminderSentAtMs: null }), NOW),
    "a call whose first reminder never went out still gets the 1 hour email",
  );
  // Reminders sent before #4282 recorded no send time. The gap is a courtesy and the
  // email is the promise, so an unknown send time sends rather than withholds.
  assert(
    hourReminderDue(booking({ dayReminderSentAtMs: null }), NOW),
    "a first reminder with no recorded send time does not hold the 1 hour email back",
  );
  assert(
    hourReminderDue(booking({ dayReminderSentAtMs: NaN }), NOW),
    "nor does one whose send time cannot be read",
  );
}

// --- an unreadable stamp sends nothing ------------------------------------------
{
  assert(!hourReminderDue(booking({ startsAtMs: NaN }), NOW), "an unreadable start sends nothing");
  assert(!hourReminderDue(booking({ createdAtMs: NaN }), NOW), "nor does an unreadable booking time");
  assert(!hourReminderDue(booking(), NaN), "nor an unreadable clock");
}

// --- the 24 hour email is not sent once the 1 hour one has gone ---------------------
//
// A 24 hour email that failed and is retried must not land after the 1 hour email for
// the same start: the later one already reminded the lead.
{
  const start = NOW + 50 * MIN;
  const subject = { startsAtMs: start, reminderSentForMs: null, hourReminderSentForMs: null, status: "confirmed" };
  assert(reminderDue(subject, NOW), "an unsent 24 hour email is due inside the window");
  assert(
    !reminderDue({ ...subject, hourReminderSentForMs: start }, NOW),
    "but not once the 1 hour email has gone for the same start",
  );
  assert(
    reminderDue({ ...subject, hourReminderSentForMs: start - 3 * HOUR }, NOW),
    "a 1 hour email about the call's old time does not count",
  );
}

// --- what it says -----------------------------------------------------------------
{
  const startsAtIso = new Date(NOW + 55 * MIN).toISOString();
  const input = {
    agentName: "Sam Rivera",
    startsAtIso,
    timezone: "America/New_York",
    manageUrl: "https://slate.example/booking/manage/tok",
    nowMs: NOW,
    callingNumber: null,
    leadPhone: null,
    onPlaceholder: false,
  };
  const subject = hourReminderSubject(input);
  const body = hourReminderBody(input);

  eq(subject, "Your Pennie call is in about an hour, at 10:55am EDT", "the subject says it is soon, and when");
  assert(body.includes("in about an hour, at 10:55am EDT"), "the body says the same");
  assert(body.includes("Sam Rivera at Pennie"), "it names the advisor who will call");
  assert(body.includes(input.manageUrl), "it carries the link to move or cancel");
  assert(/reply to this email/i.test(body), "and says a reply reaches the advisor");
  assert(!DASHES.test(subject + body), "no dashes as punctuation");

  // Sent later than the mark (a retried send), it does not claim "about an hour".
  const late = { ...input, nowMs: NOW + 20 * MIN };
  assert(hourReminderSubject(late).includes("in about 35 minutes"), "a send 35 minutes out says 35 minutes");

  const withNumber = hourReminderBody({ ...input, callingNumber: "+15551234567" });
  assert(/contact card is attached/i.test(withNumber), "with a calling number it points at the card, as the 24 hour email does");

  const placeholder = hourReminderBody({ ...input, onPlaceholder: true });
  assert(!placeholder.includes("Sam Rivera"), "a placeholder call names no advisor");
  assert(!placeholder.includes(input.manageUrl), "and carries no manage link");
  assert(!/reply to this email and it will reach me/i.test(placeholder), "and promises no reply will be read");
  assert(placeholder.includes("in about an hour, at 10:55am EDT"), "but says when the call is");

  const unreadable = hourReminderSubject({ ...input, startsAtIso: "not a time" });
  assert(!/Invalid/.test(unreadable), "an unreadable start never reaches an inbox as Invalid DateTime");
}

// --- the lead's own number (#4292, Dan 2026-10-27) --------------------------------
//
// The booking page already tells the lead the number we will call. The emails used to
// say "the number you gave us" every time, because the job never read it.
{
  const base = {
    agentName: "Sam Rivera",
    startsAtIso: new Date(NOW + 55 * MIN).toISOString(),
    timezone: "America/New_York",
    manageUrl: "https://slate.example/booking/manage/tok",
    nowMs: NOW,
    callingNumber: null,
    onPlaceholder: false,
    leadPhone: "+12155550100",
  };
  const day = reminderBody(base);
  const hour = hourReminderBody(base);
  for (const [which, body] of [["24 hour", day], ["1 hour", hour]] as const) {
    assert(body.includes("We will call you at (215) 555-0100"), `the ${which} email names the lead's number (${body.split("\n")[2]})`);
    assert(!body.includes("the number you gave us"), `and drops the fallback when the number is known (${which})`);
  }
  assert(
    hourReminderBody({ ...base, callingNumber: "+17867054716" }).includes("We will call you at (215) 555-0100. The call will come from (786) 705-4716."),
    "beside the number the call comes from",
  );
  assert(
    hourReminderBody({ ...base, onPlaceholder: true }).includes("We will call you at (215) 555-0100"),
    "the placeholder's email names it too",
  );
  const unknown = hourReminderBody({ ...base, leadPhone: null });
  assert(unknown.includes("We will call you on the number you gave us"), "with no number on file it keeps the fallback");
  assert(
    hourReminderBody({ ...base, leadPhone: "not a phone" }).includes("on the number you gave us"),
    "and an unreadable number never reaches a lead as written",
  );
}

finish();

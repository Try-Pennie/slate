// The 24 hour reminder email (#2359): which bookings are due one, and what it says.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-reminder.ts
//
// Today a lead booked through cal.com gets four messages before their call, and all
// four stop at cutover. The confirmation is covered by the Google invite (#64), the 1
// hour and 15 minute reminders by Regal's SMS journeys (#2308, #2309). This is the
// fourth, and nothing else covers it.
//
// The rules Dan settled on 2026-09-16:
//   * a booking made LESS than 24 hours ahead gets its reminder immediately, so the
//     rule is "every appointment gets one" with no special case to explain;
//   * a booking that MOVES earns a fresh reminder for its new time, because the
//     reminder is a property of the appointment rather than of the lead.
import {
  REMINDER_LEAD_MS,
  reminderDue,
  reminderSubject,
  reminderBody,
} from "../src/lib/booking/reminder.ts";
import { DateTime } from "luxon";
import { formatClockTime } from "../src/lib/date/parse.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Em/en dash detector built from escapes, so this file holds no literal dash. */
const DASHES = new RegExp("[\\u2013\\u2014]");

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 8, 16, 14, 0, 0);

const booking = (over: Partial<Parameters<typeof reminderDue>[0]> = {}) => ({
  startsAtMs: NOW + 12 * HOUR,
  reminderSentForMs: null,
  status: "confirmed" as string,
  ...over,
});

// --- the window ----------------------------------------------------------------
{
  eq(REMINDER_LEAD_MS, 24 * HOUR, "the reminder is a 24 hour one, which is what the lead is promised today");

  assert(reminderDue(booking(), NOW), "a call inside the window with no reminder recorded is due");
  assert(
    !reminderDue(booking({ startsAtMs: NOW + 25 * HOUR }), NOW),
    "a call further out than the window is not due yet",
  );
  // The boundary, both sides of it. A rolling window judged with `<=` at exactly the
  // lead time is what makes the five minute lane land the reminder within minutes of
  // the mark rather than a tick late.
  assert(reminderDue(booking({ startsAtMs: NOW + REMINDER_LEAD_MS }), NOW), "the mark itself is due");
  assert(
    !reminderDue(booking({ startsAtMs: NOW + REMINDER_LEAD_MS + 1 }), NOW),
    "one millisecond before the mark is not",
  );
}

// --- a booking made inside the window gets one straight away (Dan, 2026-09-16) ---
//
// The alternative considered was sending nothing, which is tidier for a lead booking
// two hours out and leaves the rule as "everyone gets one, unless". Dan chose the
// uniform rule, so a same day booking is reminded on the next tick.
{
  assert(reminderDue(booking({ startsAtMs: NOW + 2 * HOUR }), NOW), "a same day booking is due at once");
  assert(reminderDue(booking({ startsAtMs: NOW + 20 * MIN }), NOW), "and so is one made twenty minutes out");
}

// --- a call that has already started is never reminded about ---------------------
//
// Not a nicety: the lane reads a window and a clock, and a lead told to expect a call
// they have already had, or missed, is worse than silence.
{
  assert(!reminderDue(booking({ startsAtMs: NOW - 1 }), NOW), "a call in the past is not due");
  assert(!reminderDue(booking({ startsAtMs: NOW }), NOW), "and neither is one starting this instant");
}

// --- sent once, and not again for the same time ----------------------------------
{
  const start = NOW + 12 * HOUR;
  assert(
    !reminderDue(booking({ startsAtMs: start, reminderSentForMs: start }), NOW),
    "a booking already reminded about THIS start is not due again",
  );
  // The whole reason the record is a timestamp rather than a flag. A reschedule
  // leaves the stored value pointing at a time the booking no longer holds, so the
  // new time earns its own reminder with nobody having to clear anything (L60).
  assert(
    reminderDue(booking({ startsAtMs: NOW + 10 * HOUR, reminderSentForMs: start }), NOW),
    "a booking that MOVED is due a fresh reminder for its new time",
  );
  // And a move FURTHER OUT is simply not due yet rather than permanently sent.
  assert(
    !reminderDue(booking({ startsAtMs: NOW + 40 * HOUR, reminderSentForMs: start }), NOW),
    "a booking moved beyond the window waits, rather than counting the old reminder",
  );
  assert(
    reminderDue(booking({ startsAtMs: NOW + 40 * HOUR, reminderSentForMs: start }), NOW + 20 * HOUR),
    "and becomes due when the new time comes inside the window",
  );
}

// --- only a live booking ---------------------------------------------------------
{
  assert(reminderDue(booking({ status: "rescheduled" }), NOW), "a rescheduled booking is still a live one");
  for (const status of ["cancelled", "completed", "no_show", "pending"]) {
    assert(
      !reminderDue(booking({ status }), NOW),
      `a ${status} booking is never reminded about`,
    );
  }
}

// --- an unreadable start is not a reminder ---------------------------------------
//
// A NaN start compares false against every bound, so a check written the other way
// round would land on the permissive side and mail somebody about a time nobody can
// read (L50, L706).
{
  assert(!reminderDue(booking({ startsAtMs: NaN }), NOW), "an unreadable start is never due");
  assert(
    !reminderDue(booking({ startsAtMs: NOW + HOUR }), NaN),
    "and an unreadable clock sends nothing rather than everything",
  );
}

// --- the copy a lead reads -------------------------------------------------------
{
  const args = {
    agentName: "Jordan Lee",
    startsAtIso: new Date(NOW + 20 * HOUR).toISOString(),
    timezone: "America/New_York",
    manageUrl: "https://slate.trypennie.app/manage/abc",
  };
  const subject = reminderSubject(args);
  const body = reminderBody(args);

  assert(subject.length > 0 && subject.length < 80, "the subject fits in a phone's preview line");
  assert(/tomorrow/i.test(subject), "and says when, since that is the whole point of it");

  // It comes from the advisor's own mailbox (Dan, 2026-09-15, over a shared or
  // noreply address), so a lead who replies reaches the person they are about to
  // speak to. The copy has to sound like that person rather than like a system.
  assert(body.includes("Jordan Lee"), "the body names the advisor the lead will speak to");
  assert(/reply/i.test(body), "and invites a reply, which is why the sender is a real mailbox");
  assert(body.includes(args.manageUrl), "it carries the link to move or cancel");

  // The time is rendered in the LEAD's zone, which is the only one they can act on.
  // Asserted by deriving the expected rendering from the same instant rather than by
  // quoting an hour, because an hour written by hand is arithmetic somebody did once
  // and the test then pins the mistake (this one was wrong on the first pass).
  {
    // Derived from the SHARED spelling (#2221), not from a format string written
    // here: this file asserting its own would let the copy drift from every other
    // surface a lead reads while the test stayed green (L41).
    const expected = formatClockTime(DateTime.fromISO(args.startsAtIso, { zone: args.timezone }));
    assert(!!expected && body.includes(expected), `the time is shown in the lead's own timezone (${expected})`);
    assert(/EDT|EST/.test(body), "and names that zone, so the lead is not left converting");
    assert(!/GMT|UTC/.test(body), "never in a zone the lead did not choose");
  }

  // House style, and the guards that already exist for every other lead facing
  // string (#1343). These are read by a customer, so they get the same treatment.
  assert(!DASHES.test(body) && !DASHES.test(subject), "no dashes as punctuation");
  assert(!/undefined|NaN|\[object Object\]/.test(body), "no missing value reaches a lead");
  assert(!/undefined|NaN/.test(subject), "nor the subject line");

  // A call that is NOT tomorrow, because "tomorrow" is a claim about the lead's
  // calendar rather than about 24 hours. A booking made inside the window is due at
  // once, and for one starting in two hours "tomorrow" would be simply false.
  const sameDay = reminderSubject({ ...args, startsAtIso: new Date(NOW + 2 * HOUR).toISOString() });
  assert(!/tomorrow/i.test(sameDay), "a call later TODAY is not described as tomorrow");
  assert(/today/i.test(sameDay), "it says today instead");
}

finish();

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
  REMINDER_HOLD_MS,
  REMINDER_HOLD_FLOOR_MS,
  reminderDue,
  reminderHeld,
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

// --- a young booking is HELD so the owner hand-back lands first (#2633) ----------
//
// The hand-back moves a booking to the lead's owner seconds after it is made (26s
// in the #2630 case), and since #2630 a reassign never sends a second reminder. So a
// reminder sent at once would name, and reply to, the advisor who will NOT call.
// Both sides of every boundary are pinned, because a hold judged with the wrong
// comparison is either a tick late or no hold at all.
{
  eq(REMINDER_HOLD_MS, 10 * MIN, "the hold is ten minutes, derived from the measured hand-back");
  eq(REMINDER_HOLD_FLOOR_MS, 60 * MIN, "and never runs past an hour before the call");
  // #2839: the slowest of 56 real hand-backs measured on 2026-10-18 took 148.5s. A hold
  // shortened toward the p95 (28.4s) would send the slowest few their reminder from the
  // advisor who will not call, so it must keep at least three times that tail.
  assert(REMINDER_HOLD_MS >= 3 * 148_500, "the hold covers the slowest real hand-back three times over");

  const created = NOW;
  const start = NOW + 5 * HOUR;
  const held = (nowMs: number, over: Partial<Parameters<typeof reminderHeld>[0]> = {}) =>
    reminderHeld({ createdAtMs: created, startsAtMs: start, ...over }, nowMs);

  assert(held(created), "a booking made this instant is held");
  assert(held(created + REMINDER_HOLD_MS - 1), "one millisecond short of the hold is still held");
  assert(!held(created + REMINDER_HOLD_MS), "the hold's end itself is released");
  assert(!held(created + REMINDER_HOLD_MS + 5 * MIN), "and so is anything older");
}

// --- the floor: a call starting sooner than the hold is not held past it ---------
//
// The next thing the lead hears is Regal's one hour SMS, and this email is the one
// that carries the link to move or cancel, so it must never be held into that last
// hour. A booking made seventy minutes out is released at the hour mark, not at ten
// minutes old; one made inside the hour is not held at all.
{
  const created = NOW;
  const start = NOW + 65 * MIN;
  const held = (nowMs: number) => reminderHeld({ createdAtMs: created, startsAtMs: start }, nowMs);
  assert(held(created), "sixty five minutes out, a brand new booking is still held");
  assert(held(start - REMINDER_HOLD_FLOOR_MS - 1), "until just before the hour mark");
  assert(!held(start - REMINDER_HOLD_FLOOR_MS), "and released at the hour mark, before the hold would end");

  const soon = NOW + 30 * MIN;
  assert(
    !reminderHeld({ createdAtMs: created, startsAtMs: soon }, created),
    "a call half an hour away is sent at once despite being seconds old",
  );
}

// --- an unreadable stamp does not hold a reminder forever ------------------------
//
// The hold is a courtesy about WHICH advisor signs the email; the reminder itself is
// the promise. So an unreadable creation time or clock releases rather than holds.
{
  assert(!reminderHeld({ createdAtMs: NaN, startsAtMs: NOW + 5 * HOUR }, NOW), "an unreadable creation time is not held");
  assert(!reminderHeld({ createdAtMs: NOW, startsAtMs: NOW + 5 * HOUR }, NaN), "and neither is an unreadable clock");
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
    // No calling number known: the copy must then say nothing about one (#1334).
    callingNumber: null as string | null,
    // A routed call: the advisor's own mailbox, which is read (#4206 adds the other).
    onPlaceholder: false,
    // The copy is told what "now" is rather than reading the clock (#2497). Both
    // ends of the relationship "tomorrow" describes have to be pinned, or the
    // fixture means a different thing every day and the suite goes red with no
    // code change (L130): this one shipped on the 16th saying "tomorrow" and said
    // "today" from midnight on the 17th, which took main's deploy down with it.
    nowMs: NOW,
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

  // The control that makes the two assertions above mean something. ONE instant,
  // read from two different "now"s, must be described differently: that is only
  // true of copy that consults the clock it was GIVEN. A builder still reading
  // `DateTime.now()` renders the same word for both, and on the one day a year
  // where the real clock happens to agree with the fixture it would otherwise
  // satisfy every assertion above while being exactly the defect (L1).
  {
    // Both "now"s are derived from the CALL rather than written as arithmetic off
    // NOW, because the hour that separates the two days is Eastern and the fixture
    // is UTC: a number picked by hand here is a conversion somebody did once, and
    // the test would then pin the mistake rather than the rule (L401).
    const call = args.startsAtIso;
    const callMs = Date.parse(call);
    const nightBefore = reminderSubject({ ...args, startsAtIso: call, nowMs: NOW });
    const sameMorning = reminderSubject({ ...args, startsAtIso: call, nowMs: callMs - HOUR });
    assert(/tomorrow/i.test(nightBefore), "read the evening before, the call is tomorrow");
    assert(/today/i.test(sameMorning), "and read on the morning itself, the very same call is today");
  }

  // A clock the caller could not read must not become "Invalid DateTime" in a
  // lead's inbox, and must not silently pick a day either.
  {
    const unreadable = reminderSubject({ ...args, nowMs: NaN });
    assert(!/undefined|NaN|Invalid/.test(unreadable), "an unreadable clock leaks nothing into the subject");
    assert(!/today|tomorrow/i.test(unreadable), "and claims no day it could not work out");
  }

  // --- the number we will call FROM (#1334) --------------------------------------
  // Call screening silences a number the lead has never seen. When the calling number
  // is known the reminder names it and points at the attached card; when it is not,
  // it says nothing about a number at all, because a wrong number is worse than none.
  {
    const withNumber = reminderBody({ ...args, callingNumber: "+12197588170" });
    assert(withNumber.includes("(219) 758-8170"), "the calling number is named, formatted for a person to read");
    assert(/contact card/i.test(withNumber), "and the attached contact card is mentioned, so the lead knows to open it");
    // The card is named after the advisor again, and the email comes from them, so
    // with a real name it is "my" card (Dan reversed the earlier call, 2026-10-01).
    assert(/My contact card is attached/.test(withNumber), "a named advisor attaches MY contact card");
    assert(!/Our contact card/.test(withNumber), "and not Pennie's");
    assert(!/nothing you need to set up/i.test(withNumber), "the old 'nothing to set up' line is gone when there is something to save");
    assert(!DASHES.test(withNumber), "no dashes as punctuation");
    assert(withNumber.includes(args.manageUrl) && withNumber.includes("Jordan Lee"), "the rest of the reminder is unchanged");

    const without = reminderBody(args);
    assert(!/\(\d{3}\) \d{3}/.test(without) && !/\+1\d{10}/.test(without), "with no calling number, no number is printed");
    assert(!/contact card|come from/i.test(without), "and nothing promises a card or a calling number");
  }

  // --- an advisor with no real name (#1334 review) -------------------------------
  // The lane used to fall back to the advisor's ADDRESS, which then greeted the lead
  // with "your call with jordan@trypennie.com" and signed the email with it. An
  // address is never shown as a name: the copy speaks for Pennie instead.
  for (const agentName of [null, "", "jordan@trypennie.com"]) {
    const label = JSON.stringify(agentName);
    for (const callingNumber of [null, "+12197588170"]) {
      const body = reminderBody({ ...args, agentName, callingNumber });
      assert(!body.includes("@"), `${label}: no address appears in the body`);
      assert(!/null|undefined/.test(body), `${label}: no missing value leaks into it`);
      assert(/your call with Pennie is/i.test(body), `${label}: the call is with Pennie`);
      assert(/Your Pennie advisor$/.test(body), `${label}: and it is signed as the lead's Pennie advisor`);
      if (callingNumber) {
        assert(/Our contact card is attached/.test(body), `${label}: with no real name the card is Pennie's, OUR card`);
        assert(!/My contact card/.test(body), `${label}: and never "my" card`);
      }
    }
  }
}

// --- a call on the placeholder advisor, Marcia (#4206, Dan 2026-10-26) --------------
// The reminder goes out from the placeholder seat, whose inbox nobody reads. So it
// never invites a reply to itself, names no number, offers no way to change the call
// (Dan, 2026-10-27: a customer who texts asking to change it is handled then), and
// sends a question to our texts.
{
  const args = {
    agentName: "Marcia",
    startsAtIso: new Date(NOW + 20 * HOUR).toISOString(),
    timezone: "America/New_York",
    manageUrl: "https://slate.trypennie.app/manage/abc",
    callingNumber: null as string | null,
    onPlaceholder: true,
    nowMs: NOW,
  };
  for (const callingNumber of [null, "+12197588170"]) {
    const body = reminderBody({ ...args, callingNumber });
    const label = `number ${callingNumber ?? "unknown"}`;
    assert(
      body.includes("Nobody reads replies to this email. If you have a question, reply to one of our texts and someone will answer you there."),
      `${label}: it sends a question to our texts`,
    );
    assert(!body.includes(args.manageUrl), `${label}: it carries no manage link`);
    assert(!/pick another|cancel|change/i.test(body), `${label}: and never offers to change or cancel the call`);
    assert(/Nobody reads replies to this email/.test(body), `${label}: and says a reply to the email is not read`);
    assert(!/reply to this email and it will reach me/i.test(body), `${label}: never the routed promise that a reply is read`);
    assert(!/\(\d{3}\) \d{3}|\+1\d{10}/.test(body), `${label}: no number of any kind is named`);
    assert(!/contact card|come from/i.test(body), `${label}: and no card or calling number line`);
    assert(!body.includes("Marcia"), `${label}: the seat's name is not presented as the advisor calling`);
    assert(/your call with Pennie is/.test(body), `${label}: the call is with Pennie`);
    assert(/The Pennie team$/.test(body), `${label}: signed by the Pennie team`);
    assert(!DASHES.test(body), `${label}: no dashes as punctuation`);
  }
  eq(reminderSubject(args), reminderSubject({ ...args, onPlaceholder: false }), "the subject is the same either way");
}

finish();

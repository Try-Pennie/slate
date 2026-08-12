/**
 * Every string a LEAD can read, grouped by screen and by the state that produces
 * it (#1343).
 *
 * The point of this file is to be READ. The 2026-08-07 design session was a
 * person clicking through a mockup one screen at a time and catching wording by
 * eye, and none of what they found could have been found by reading the code.
 * `pnpm preview:booker` prints all of it at once so the next pass takes minutes
 * rather than a session.
 *
 * The rule that makes it trustworthy, and the reason it is worth having at all:
 * **it CALLS the real copy builders and never holds its own copy of the wording**
 * (L41). A preview showing text that is not what ships would be worse than no
 * preview, because it would be believed. That is why the copy lives in
 * booker-copy.ts / manage-copy.ts rather than inline in the components, and why
 * `scripts/test-booker-preview-coverage.ts` checks that a rendered component and
 * this preview resolve the SAME string.
 *
 * Deterministic: every date, name and number here is a fixture, and nothing reads
 * the clock. A diff in `pnpm preview:booker` therefore means the copy changed,
 * never that the day did.
 */
import {
  BOOKING_ERROR_COPY,
  CONFIRMED_COPY,
  DETAILS_COPY,
  DUPLICATE_COPY,
  HONEYPOT_LABEL,
  INCOMPLETE_PHONE_NOTICE,
  EXTENSION_PHONE_PREFILL_NOTICE,
  PHONE_EXTENSION_NOTICE,
  US_ONLY_PHONE_NOTICE,
  MOVE_COPY,
  NEXT_DAYS_COPY,
  PICKER_COPY,
  CLOSED_BODY,
  UNCLASSIFIED_EMPTY_NOTICE,
  UNCLASSIFIED_EMPTY_RETRY,
  allTimesTaken,
  closedNoReopenDate,
  closedUntil,
  confirmedAnnouncement,
  confirmedWhen,
  duplicateSetFor,
  inviteOnItsWay,
  keepExistingTime,
  moveToTime,
  phoneEchoLine,
  timesAvailableAnnouncement,
} from "@/lib/booking/booker-copy";
import {
  BEFORE_COPY,
  CANCEL_COPY,
  DONE_COPY,
  LIVE_COPY,
  RESCHEDULE_COPY,
  advisorWillCall,
  doneBody,
  doneHeading,
  liveHeading,
} from "@/lib/booking/manage-copy";

/** One line of copy, and the state that puts it on screen. */
export interface CopyLine {
  /** What produces it, in a reader's terms: "a day is chosen and its times are gone". */
  state: string;
  text: string;
  /** Set when only assistive tech hears this, so a reader knows why it is terse. */
  screenReaderOnly?: boolean;
}

export interface CopyScreen {
  /** The surface, as a person would name it. */
  screen: string;
  /** What this screen is for, so a reader knows what the copy has to achieve. */
  purpose: string;
  lines: CopyLine[];
}

/** Fixtures. Fixed values, never the clock, so the render is stable (see header). */
const ZONE = "America/New_York";
const DAY = "Monday, August 17";
const TIME = "2:30 PM";
const ZONE_LABEL = "EDT";
const PHONE = "(215) 555-0100";
const EMAIL = "dana@example.com";

export function bookerCopyScreens(): CopyScreen[] {
  return [
    {
      screen: "Booker: choosing a time",
      purpose:
        "The lead has landed and has to get from a page of days to one chosen time. " +
        "Every state here has to say what to do next, not merely what is true.",
      lines: [
        { state: "the days are still loading", text: PICKER_COPY.loading },
        { state: "the load failed", text: PICKER_COPY.failed },
        { state: "days are offered and none is chosen yet", text: PICKER_COPY.pickADay },
        { state: "a chosen day whose times have all gone", text: PICKER_COPY.dayEmpty(DAY) },
        {
          state: "a day's times settled",
          text: timesAvailableAnnouncement(6, DAY),
          screenReaderOnly: true,
        },
        {
          state: "one time left, so the count must not read as plural",
          text: timesAvailableAnnouncement(1, DAY),
          screenReaderOnly: true,
        },
      ],
    },
    {
      screen: "Booker: nothing bookable nearby",
      purpose:
        "Three different causes that a single 'check back soon' used to flatten. " +
        "The office being shut is not the same as every time being taken, and " +
        "neither is the same as not knowing which it is.",
      lines: [
        { state: "every time in the window is taken", text: allTimesTaken() },
        { state: "closed, with a known reopening day", text: closedUntil("2026-08-17", ZONE) },
        {
          state: "and what follows it, only when there is a day to point at",
          text: CLOSED_BODY,
        },
        { state: "closed, with no reopening day recorded", text: closedNoReopenDate() },
        {
          state: "the window is empty and nothing said why",
          text: UNCLASSIFIED_EMPTY_NOTICE,
        },
        { state: "and the way out of that", text: UNCLASSIFIED_EMPTY_RETRY },
      ],
    },
    {
      screen: "Booker: looking further ahead",
      purpose:
        "The slowest lead-facing action in the product, so it has to keep working, " +
        "still alive and failed visibly apart.",
      lines: [
        { state: "the button at rest", text: NEXT_DAYS_COPY.ask },
        { state: "the search is running", text: NEXT_DAYS_COPY.looking },
        { state: "it has been running a while", text: NEXT_DAYS_COPY.stillLooking },
        { state: "the search failed", text: NEXT_DAYS_COPY.failed },
        { state: "the button after a failure", text: NEXT_DAYS_COPY.retry },
        { state: "it looked and there is genuinely nothing", text: NEXT_DAYS_COPY.foundNothing },
      ],
    },
    {
      screen: "Booker: the details step",
      purpose: "The last screen before a commitment, so nothing here may over promise.",
      lines: [
        { state: "the button at rest", text: DETAILS_COPY.confirm },
        { state: "the booking is being made", text: DETAILS_COPY.confirming },
        { state: "it has been running a while", text: DETAILS_COPY.stillWorking },
        {
          state: "their number, echoed back",
          text: phoneEchoLine(PHONE),
        },
        {
          state: "they arrived with a number we cannot call, so the field is empty",
          text: US_ONLY_PHONE_NOTICE,
        },
        {
          state: "they arrived with an unfinished number, so the field is empty",
          text: INCOMPLETE_PHONE_NOTICE,
        },
        {
          state: "they arrived with a number carrying an extension, so the field is empty",
          text: EXTENSION_PHONE_PREFILL_NOTICE,
        },
        {
          state: "they typed a number carrying an extension",
          text: PHONE_EXTENSION_NOTICE,
        },
        { state: "the bot trap", text: HONEYPOT_LABEL, screenReaderOnly: true },
      ],
    },
    {
      screen: "Booker: it did not go through",
      purpose:
        "Each cause is its own sentence: a taken time tells the lead to pick again, " +
        "where a generic failure would leave them staring at a working page.",
      lines: [
        { state: "somebody took the time while they typed", text: BOOKING_ERROR_COPY.slotTaken },
        { state: "anything else", text: BOOKING_ERROR_COPY.generic },
        { state: "moving an existing call failed", text: BOOKING_ERROR_COPY.moveFailed },
      ],
    },
    {
      screen: "Booker: confirmed",
      purpose: "The one branded moment, and the last thing most leads will read.",
      lines: [
        { state: "the heading", text: CONFIRMED_COPY.heading },
        { state: "when it is", text: confirmedWhen(DAY, TIME, ZONE_LABEL) },
        { state: "the invite", text: inviteOnItsWay(EMAIL) },
        {
          state: "the invite, with no address to name",
          text: inviteOnItsWay(""),
        },
        { state: "the link onward", text: CONFIRMED_COPY.manageLink },
        {
          state: "what is announced",
          text: confirmedAnnouncement(DAY, TIME, ZONE_LABEL),
          screenReaderOnly: true,
        },
      ],
    },
    {
      screen: "Booker: you already have a call booked",
      purpose:
        "A weak match may be somebody ELSE's booking (a shared household phone, a " +
        "couple on one email), so the withheld version must work while naming nothing.",
      lines: [
        { state: "the heading", text: DUPLICATE_COPY.heading },
        {
          state: "the match was strong enough to name it",
          text: duplicateSetFor(`${DAY} at ${TIME}`),
        },
        { state: "and the way to act on it", text: DUPLICATE_COPY.viewOrCancel },
        {
          state: "the match was one signal only, so nothing is named",
          text: DUPLICATE_COPY.checkYourEmail,
        },
      ],
    },
    {
      screen: "Booker: moving the call they already have",
      purpose: "Reached from the duplicate notice, so it has to name the call being moved.",
      lines: [
        { state: "why they are moving it", text: MOVE_COPY.reasonLegend },
        { state: "a time is chosen", text: moveToTime(`${DAY} at ${TIME}`) },
        { state: "no time chosen yet", text: MOVE_COPY.moveNoTime },
        { state: "the move is running", text: MOVE_COPY.moving },
        { state: "the way out", text: keepExistingTime("Mon") },
      ],
    },
    {
      screen: "Manage: the call is still to come",
      purpose:
        "Someone arriving from the confirmation email. It must answer who is calling " +
        "and on what number without guessing a pronoun for the advisor.",
      lines: [
        { state: "the advisor and the countdown both resolved", text: liveHeading("Priya", "in 2 days") },
        { state: "only the countdown resolved", text: liveHeading(null, "in 2 days") },
        { state: "neither resolved", text: liveHeading(null, null) },
        { state: "the number we hold", text: advisorWillCall(PHONE) },
        { state: "no number on the booking", text: advisorWillCall(null) },
        { state: "what they can still do", text: LIVE_COPY.changeYourPlans },
        { state: "the softer control", text: LIVE_COPY.reschedule },
        { state: "the irreversible one", text: LIVE_COPY.cancel },
        { state: "an action has been running a while", text: LIVE_COPY.stillWorking },
      ],
    },
    {
      screen: "Manage: before the call",
      purpose: "The only place the lead is told how to be ready.",
      lines: [
        { state: "the heading", text: BEFORE_COPY.heading },
        { state: "the advice", text: BEFORE_COPY.body },
      ],
    },
    {
      screen: "Manage: confirming a cancel",
      purpose:
        "The one irreversible thing a lead can do here, so it must state the cost " +
        "before they commit and offer a way out worded as keeping what they have.",
      lines: [
        { state: "the question", text: CANCEL_COPY.heading },
        { state: "what it costs", text: CANCEL_COPY.consequence },
        { state: "why they are cancelling", text: CANCEL_COPY.reasonLegend },
        { state: "the commit", text: CANCEL_COPY.confirm },
        { state: "while it runs", text: CANCEL_COPY.confirming },
        { state: "the way out", text: CANCEL_COPY.keep },
        { state: "it failed", text: CANCEL_COPY.failed },
      ],
    },
    {
      screen: "Manage: picking a new time",
      purpose:
        "The same picker the booker runs on, so a lead moving a call meets the " +
        "surface they booked on.",
      lines: [
        { state: "why they are moving it", text: RESCHEDULE_COPY.reasonLegend },
        { state: "a reason is set, so the times are live", text: RESCHEDULE_COPY.pickReady },
        { state: "no reason yet, so they are not", text: RESCHEDULE_COPY.pickBlocked },
        { state: "the time they pressed", text: RESCHEDULE_COPY.moving },
        { state: "nothing is offered", text: RESCHEDULE_COPY.noTimes },
        { state: "the way out", text: RESCHEDULE_COPY.keepCurrent },
        { state: "it failed", text: RESCHEDULE_COPY.failed },
      ],
    },
    {
      screen: "Manage: the booking is over",
      purpose:
        "Cancelled and already happened are different screens. Offering 'grab a new " +
        "time' to somebody whose call just happened reads as though we did not notice.",
      lines: [
        { state: "they cancelled it", text: doneHeading("cancelled") },
        { state: "and what to do about it", text: doneBody("cancelled") },
        { state: "the call took place", text: doneHeading("completed") },
        { state: "and what to do about that", text: doneBody("completed") },
        { state: "the way onward, either way", text: DONE_COPY.bookAgain },
      ],
    },
  ];
}

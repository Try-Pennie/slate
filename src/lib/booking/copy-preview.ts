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
  LEGAL_COPY,
  legalLinks,
  contactDisclosure,
  DUPLICATE_COPY,
  HONEYPOT_LABEL,
  INCOMPLETE_PHONE_NOTICE,
  EXTENSION_PHONE_PREFILL_NOTICE,
  US_ONLY_PHONE_NOTICE,
  MOVE_COPY,
  BOOKER_PHONE_COPY,
  NEXT_DAYS_COPY,
  PICKER_COPY,
  CLOSED_BODY,
  UNCLASSIFIED_EMPTY_NOTICE,
  UNCLASSIFIED_EMPTY_RETRY,
  allTimesTaken,
  noAdvisorsAvailable,
  closedNoReopenDate,
  closedUntil,
  confirmedAnnouncement,
  confirmedWhen,
  duplicateSetFor,
  inviteOnItsWay,
  BOOKER_CANCEL_COPY,
  cancelConsequenceFor,
  keepExistingTime,
  movedContactNote,
  moveToTime,
  phoneEchoLine,
  timesAvailableAnnouncement,
  NEAREST_TIMES_COPY,
} from "@/lib/booking/booker-copy";
import {
  BEFORE_COPY,
  CANCEL_COPY,
  DONE_COPY,
  LIVE_COPY,
  RESCHEDULE_COPY,
  MANAGE_PHONE_NOT_CHANGEABLE,
  MANAGE_PHONE_NOT_FOUND,
  PHONE_COPY,
  advisorWillCall,
  doneBody,
  doneHeading,
  liveHeading,
  movedNote,
  phoneSaved,
} from "@/lib/booking/manage-copy";
import { eventDescription, eventSummary } from "@/lib/booking/core";
import { formatSlotTime } from "@/lib/booking/slot-label";
import { REASSIGN_INVITE_DESCRIPTION } from "@/lib/booking/orchestration";

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
/**
 * A FIXED instant, spelled by the shared formatter rather than written out here
 * (#1765).
 *
 * These builders take an already formatted time as a parameter, so a literal
 * slipped past the guard that forbids a literal `text`. It was "2:30 PM" while
 * every screen shipped "2:30pm", which makes the preview show copy that is not
 * what a lead reads, and a preview that is believed and wrong is worse than none.
 * The instant is fixed, so the render stays deterministic.
 */
const TIME = formatSlotTime("2026-08-17T18:30:00.000Z", ZONE);
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
        {
          state: "the bucket has nobody in it at all",
          text: noAdvisorsAvailable(),
        },
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
        { state: "the search could not be reached", text: NEXT_DAYS_COPY.failed },
        { state: "the search answered with something unreadable", text: NEXT_DAYS_COPY.unreadable },
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
          state:
            "they arrived with a number we cannot call, or typed one carrying an extension",
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
          state: "what handing over the number leads to (#1041)",
          text: contactDisclosure(),
        },
        { state: "the bot trap", text: HONEYPOT_LABEL, screenReaderOnly: true },
      ],
    },
    {
      screen: "Booker and manage: the legal footer",
      purpose:
        "The standalone booker has no trypennie.com page around it to inherit " +
        "Pennie's policies from, and it is the one a lead can reach directly. " +
        "These are the only words on any Slate surface that point a customer at " +
        "a policy, so a wrong or dead one is not a small error.",
      lines: [
        { state: "the group's label", text: LEGAL_COPY.heading, screenReaderOnly: true },
        ...legalLinks().map((l) => ({ state: `link to ${l.href}`, text: l.label })),
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
        // #2297: the two refusals the kill switch produces. They share a status code
        // and must not share a sentence: one is somebody holding bookings on purpose
        // and cannot be waited out, the other clears itself.
        { state: "booking has been stopped by hand", text: BOOKING_ERROR_COPY.bookingsPaused },
        {
          state: "we could not read whether booking is stopped",
          text: BOOKING_ERROR_COPY.bookingPauseUnreadable,
        },
      ],
    },
    {
      screen: "Booker and manage: the soonest times still open",
      purpose:
        "What sits UNDER a refusal (#1319, #1549). The lead has filled in every field and " +
        "pressed the final button, or has come from their confirmation email to move the " +
        "call they already have, so a refusal with nothing beneath it is where they give " +
        "up. Read the six states together: two of them are the ones that quietly turn a " +
        "recovery back into a dead end, and the two hints are the same place saying " +
        "different things to two different people.",
      lines: [
        { state: "still fetching the fresh times", text: NEAREST_TIMES_COPY.looking },
        { state: "there are alternatives", text: NEAREST_TIMES_COPY.heading },
        { state: "under the list, so a tap is not a booking", text: NEAREST_TIMES_COPY.hint },
        {
          state: "under the list, for a lead moving a call they already have",
          text: NEAREST_TIMES_COPY.hintMove,
        },
        { state: "we looked and there is genuinely nothing", text: NEAREST_TIMES_COPY.none },
        { state: "we could NOT look, which is not the same thing", text: NEAREST_TIMES_COPY.lookupFailed },
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
      purpose:
        "Reached on landing when the link identifies the lead, and from the duplicate " +
        "notice after a confirm. It has to name the call being moved.",
      lines: [
        // #2166: the landing panel, which has no picked time behind it. It is the
        // FIRST thing a lead sees on a link that identifies them, so it is
        // previewed first.
        { state: "reached on landing, so the way on is the picker", text: MOVE_COPY.pickAnotherTime },
        { state: "why they are moving it", text: MOVE_COPY.reasonLegend },
        { state: "a time is chosen", text: moveToTime(`${DAY} at ${TIME}`) },
        { state: "no time chosen yet", text: MOVE_COPY.moveNoTime },
        { state: "the move is running", text: MOVE_COPY.moving },
        { state: "the way out", text: keepExistingTime("Mon") },
        // #2207: the number the call depends on, and the way to fix it, on the one
        // screen a lead who never received their invite email can reach. Shown in
        // full (#2213), in the same sentence the manage page says, so this line
        // reads identically on both screens. The control's own words are
        // PHONE_COPY, previewed under "Manage: correcting the number": one
        // control, one vocabulary (L41).
        { state: "the number we will ring", text: advisorWillCall(PHONE) },
        { state: "the call carries no number at all", text: BOOKER_PHONE_COPY.noNumber },
        { state: "and the way to give us one", text: BOOKER_PHONE_COPY.addTrigger },
        // #2167: the exit. A lead who lost the invite, or never received it, had
        // no way to cancel from Slate at all: the panel that recognised them was
        // the one place the product knew exactly who they were and the one place
        // it withheld this.
        { state: "the way to cancel it, before it is confirmed", text: BOOKER_CANCEL_COPY.start },
        { state: "confirming that cancel", text: BOOKER_CANCEL_COPY.heading },
        { state: "what it costs, naming the call", text: cancelConsequenceFor(`${DAY} at ${TIME}`) },
        { state: "why they are cancelling", text: BOOKER_CANCEL_COPY.reasonLegend },
        { state: "the destructive control itself", text: BOOKER_CANCEL_COPY.confirm },
        { state: "while it runs", text: BOOKER_CANCEL_COPY.confirming },
        { state: "the way back out of it", text: BOOKER_CANCEL_COPY.keep },
        { state: "a cancel that would not land", text: BOOKER_CANCEL_COPY.failed },
        { state: "the call is gone", text: BOOKER_CANCEL_COPY.doneHeading },
        { state: "and they came here to book", text: BOOKER_CANCEL_COPY.doneBookAgain },
        // #2164: what the move ALSO changed, when the lead typed new details on
        // the way to it. Every shape is previewed, because the sentence is
        // assembled from which fields moved and the list is where it can read
        // wrongly.
        {
          state: "the move also corrected all three details",
          text: movedContactNote({ name: true, email: true, phone: true }) ?? "",
        },
        {
          state: "the move also corrected the number only",
          text: movedContactNote({ name: false, email: false, phone: true }) ?? "",
        },
        {
          state: "the move also corrected the email and the number",
          text: movedContactNote({ name: false, email: true, phone: true }) ?? "",
        },
        {
          state: "the move also corrected the name only",
          text: movedContactNote({ name: true, email: false, phone: false }) ?? "",
        },
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
      screen: "Manage: correcting the number",
      purpose:
        "The number the advisor rings is the one fact on this page the call " +
        "actually depends on. A mistyped digit means the advisor dials, nobody " +
        "picks up, and it is recorded as a no show. Every refusal here has to say " +
        "which problem it is, because they send the reader somewhere different.",
      lines: [
        { state: "at rest, offering the correction", text: PHONE_COPY.trigger },
        { state: "the field is open", text: PHONE_COPY.heading },
        { state: "why we want it", text: PHONE_COPY.hint },
        { state: "the save is in flight", text: PHONE_COPY.saving },
        { state: "the save is taking too long", text: PHONE_COPY.stillWorking },
        { state: "the way back out", text: PHONE_COPY.cancel },
        { state: "the save committed", text: phoneSaved(PHONE) },
        { state: "the save failed for no stated reason", text: PHONE_COPY.failed },
        { state: "a link that resolves to no booking", text: MANAGE_PHONE_NOT_FOUND },
        { state: "a call that has already happened", text: MANAGE_PHONE_NOT_CHANGEABLE },
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
        "surface they booked on, and what the move says for itself once it lands.",
      lines: [
        { state: "why they are moving it", text: RESCHEDULE_COPY.reasonLegend },
        { state: "a reason is set, so the times are live", text: RESCHEDULE_COPY.pickReady },
        { state: "no reason yet, so they are not", text: RESCHEDULE_COPY.pickBlocked },
        { state: "the time they pressed", text: RESCHEDULE_COPY.moving },
        { state: "nothing is offered", text: RESCHEDULE_COPY.noTimes },
        { state: "the way out", text: RESCHEDULE_COPY.keepCurrent },
        { state: "it failed", text: RESCHEDULE_COPY.failed },
        // #2215: said by the move done on this page and by nothing else, so a
        // later visit to the same link is never told it has just happened.
        { state: "the move landed", text: RESCHEDULE_COPY.moved },
        { state: "and what follows it", text: movedNote(EMAIL) },
        { state: "no address on the booking", text: movedNote(null) },
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


/**
 * The copy a lead reads in their CALENDAR, which the two screens above do not
 * cover (#1421).
 *
 * Arguably the highest-stakes wording in the product: it is what the lead still
 * has in front of them on the day, it carries the only link they have for moving
 * or cancelling the call, and it is where the advisor reads their number from.
 * Until now it was written and shipped without anybody reading it rendered.
 *
 * Pure, like the two above, so this stays importable from the jsdom parity test's
 * module graph. The EMBED's copy needs a file read, so it lives in `embed-copy.ts`
 * and is assembled by the preview script.
 */
export function inviteCopyScreens(): CopyScreen[] {
  const manageUrl = "https://slate.trypennie.app/booking/manage/8f2c1a";
  return [
    {
      screen: "Calendar invite: the appointment",
      purpose:
        "What the lead has in front of them for the whole week before the call, and " +
        "the only place they are given a way to move or cancel it.",
      lines: [
        { state: "the title", text: eventSummary("Pennie consultation", "Dana Lee") },
        {
          state: "the title when we never got a name",
          text: eventSummary("Pennie consultation", null),
        },
        {
          state: "the body, with the number the advisor will dial",
          text: eventDescription(PHONE, manageUrl),
        },
        {
          state: "and with no number on the booking",
          text: eventDescription(null, manageUrl),
        },
      ],
    },
    {
      screen: "Calendar invite: a different advisor",
      purpose:
        "The ONE notification a lead gets when their booking is moved to another " +
        "advisor, so it has to explain a fresh invite for a call they already have.",
      lines: [
        { state: "the body", text: REASSIGN_INVITE_DESCRIPTION },
      ],
    },
  ];
}

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
import { zoneLabel } from "@/lib/booking/timezones";
import {
  ADD_TO_CALENDAR_COPY,
  BOOKING_ERROR_COPY,
  confirmedAdvisor,
  CONFIRMED_COPY,
  CALENDAR_COPY,
  DETAILS_COPY,
  LEGAL_COPY,
  legalLinks,
  DUPLICATE_COPY,
  HONEYPOT_LABEL,
  INCOMPLETE_PHONE_NOTICE,
  EXTENSION_PHONE_PREFILL_NOTICE,
  US_ONLY_PHONE_NOTICE,
  MOVE_COPY,
  BOOKER_PHONE_COPY,
  NEXT_DAYS_COPY,
  PICKER_COPY,
  INLINE_CARD_COPY,
  CALL_ME_NOW_COPY,
  CLOSED_BODY,
  UNCLASSIFIED_EMPTY_NOTICE,
  UNCLASSIFIED_EMPTY_RETRY,
  allTimesTaken,
  noAdvisorsAvailable,
  closedNoReopenDate,
  closedUntil,
  chosenWhen,
  confirmedAnnouncement,
  confirmedWhen,
  longDayLabel,
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
  TEST_MODE_COPY,
  DEMO_MODE_COPY,
  TEST_ACCESS_COPY,
  AGENT_LINK_COPY,
  BOOKER_BOUNDARY_COPY,
} from "@/lib/booking/booker-copy";
import { boundaryReference } from "@/lib/errors/boundary-copy";
import { INVALID_EMAIL } from "@/lib/attendee";
import {
  BEFORE_COPY,
  CANCEL_COPY,
  DONE_COPY,
  LIVE_COPY,
  NOT_FOUND_COPY,
  RESCHEDULE_COPY,
  MANAGE_PHONE_NOT_CHANGEABLE,
  MANAGE_PHONE_NOT_FOUND,
  PHONE_COPY,
  advisorWillCall,
  callComesFrom,
  callWhen,
  doneBody,
  doneHeading,
  movedNote,
  phoneSaved,
  rescheduleNoTimes,
} from "@/lib/booking/manage-copy";
import { DateTime } from "luxon";
import {
  eventDescription,
  eventLocation,
  eventSummary,
  validateReason,
  RESCHEDULE_REASONS,
  type ReasonInput,
} from "@/lib/booking/core";

/**
 * What a lead is told when they commit without a reason (#2605).
 *
 * Called rather than quoted, because it is `validateReason`'s own sentence and
 * the server answers with the same one: a copy here would be a second wording
 * for one rule, which is exactly what this preview exists to prevent (L41).
 */
function reasonRefusal(input: ReasonInput): string {
  const checked = validateReason(input, RESCHEDULE_REASONS);
  return checked.ok ? "" : checked.error;
}
import { formatSlotTime } from "@/lib/booking/slot-label";
import { REASSIGN_INVITE_DESCRIPTION } from "@/lib/booking/orchestration";
import { reminderBody, reminderSubject, hourReminderBody, hourReminderSubject } from "@/lib/booking/reminder";

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
const SLOT_ISO = "2026-08-17T18:30:00.000Z";
/**
 * The same fixed instant, spelled the way every COMMITMENT READBACK spells it:
 * the full weekday, month, day and year (#2205).
 *
 * Built by the shared formatter rather than written out beside `DAY`, so the
 * preview cannot show a date the product does not produce. `DAY` stays for the
 * places that legitimately name a day without committing to it (a day whose times
 * have gone, the count announced when a day settles).
 */
const DAY_FULL = longDayLabel(SLOT_ISO, ZONE, { year: true });
/** The same instant as the move panel abbreviates it, which is a choice being
 *  previewed rather than a commitment being read back. */
const DAY_SHORT = DateTime.fromISO(SLOT_ISO, { zone: ZONE }).toFormat("ccc, LLL d");
const TIME = formatSlotTime(SLOT_ISO, ZONE);
const ZONE_LABEL = "EDT";
const PHONE = "(215) 555-0100";
/** The same number as the bookings table stores it (E.164), for the invite's location. */
const STORED_PHONE = "+12155550100";
/** #1334: a Regal calling line, as Salesforce stores it (E.164). */
const CALLING_NUMBER = "+12197588170";
const EMAIL = "dana@example.com";
const ADVISOR = "Aisha Bello";

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
        // #3718: the inline card shows six times and offers the rest.
        { state: "the inline card, more times than it shows", text: PICKER_COPY.viewMore },
        { state: "a chosen day whose times have all gone", text: PICKER_COPY.dayEmpty(DAY) },
        // #2310: the day HAS times, all before 8:00am or from 8:00pm on the lead's
        // clock. Read beside the line above: this must not say nothing is left.
        {
          state: "a chosen day whose times are all outside the lead's calling hours",
          text: PICKER_COPY.outsideCallingHours(DAY),
        },
        // The same state on the ADMIN reschedule panel, where the reader is staff
        // and the clock is the lead's (L659): it names the lead's zone.
        {
          state: "the same, read by staff on the admin panel for a Hawaii lead",
          text: PICKER_COPY.outsideCallingHoursForStaff(DAY, "Pacific/Honolulu"),
        },
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
        // #2208 moved this here from the details step, because that is where it is
        // shown now. It reads back the number a landing link arrived with, on the
        // one screen where there is no field carrying it: once a time is picked the
        // form states it, and two copies of one number on one screen is the
        // duplication this preview exists to make visible (L605).
        {
          state: "the link arrived with a number, and no time is picked yet",
          text: phoneEchoLine(PHONE),
        },
      ],
    },
    {
      screen: "Booker: the inline card on a landing page",
      purpose: "A landing page draws this card in place (#3718). It is a card in someone else's page, so it names what it is for before anything else.",
      lines: [
        { state: "the card's title", text: INLINE_CARD_COPY.title },
        { state: "over the day strip and times", text: INLINE_CARD_COPY.chooseTime },
        { state: "under the times, naming their zone", text: INLINE_CARD_COPY.timesIn(zoneLabel("America/New_York")) },
      ],
    },
    {
      screen: "Booker: the inline card's Call me now",
      purpose:
        "A lead on a landing page asks for an advisor to call them now (#3718). The confirmation is trypennie's own, " +
        "and a press that did not go through must never read as one that did.",
      lines: [
        { state: "the row's question", text: CALL_ME_NOW_COPY.ready },
        { state: "the row's line under it", text: CALL_ME_NOW_COPY.haveCall },
        { state: "the button", text: CALL_ME_NOW_COPY.button },
        { state: "the button while the press is in flight", text: CALL_ME_NOW_COPY.pressing },
        { state: "confirmed, the page sent a name", text: CALL_ME_NOW_COPY.thanks("Maria") },
        { state: "confirmed, the page sent no name", text: CALL_ME_NOW_COPY.thanks(null) },
        { state: "confirmed, under the thanks", text: CALL_ME_NOW_COPY.momentarily },
        { state: "over the steps", text: CALL_ME_NOW_COPY.expect },
        ...CALL_ME_NOW_COPY.steps.flatMap((step, i) => [
          { state: `step ${i + 1}`, text: step.title },
          { state: `step ${i + 1}, its explanation`, text: step.body },
        ]),
        { state: "the text us card, only when a texting line came back", text: CALL_ME_NOW_COPY.textHeading },
        { state: "the text us card's line", text: CALL_ME_NOW_COPY.textBody },
        { state: "the text us button", text: CALL_ME_NOW_COPY.textButton },
        { state: "the message the text us link starts", text: CALL_ME_NOW_COPY.textMessage },
        { state: "the way back to the times", text: CALL_ME_NOW_COPY.instead },
        { state: "the way back's link", text: CALL_ME_NOW_COPY.insteadLink },
        { state: "the press did not go through", text: CALL_ME_NOW_COPY.failedHeading },
        { state: "the line under it, the row above the times", text: CALL_ME_NOW_COPY.failedBody("above") },
        { state: "the line under it, the row below the times", text: CALL_ME_NOW_COPY.failedBody("below") },
        { state: "and the retry, offered when Salesforce failed or the press came too often, never on a refusal", text: CALL_ME_NOW_COPY.tryAgain },
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
      purpose:
        "The last screen before a commitment, so nothing here may over promise, and " +
        "the highest intent screen in the product, so it has to state the time it is " +
        "committing to in full (#2361). Read the four field labels together: the name " +
        "is asked in two fields now, the way cal.com asks, so the first name is " +
        "answered rather than worked out from whatever was typed (#2362). Nothing " +
        "stands between the last field and the button any more (#2204): the sentence " +
        "that did explained the button and the field, which every other word here " +
        "already says better. For a lead the link identifies these fields arrive " +
        "filled (#2208), so read them as a form somebody is checking rather than one " +
        "they are starting.",
      lines: [
        { state: "what the screen is for", text: DETAILS_COPY.heading },
        {
          state: "the chosen time, stated in full",
          text: chosenWhen(longDayLabel(SLOT_ISO, ZONE, { year: true }), TIME),
        },
        ...Object.values(DETAILS_COPY.fields).map((label) => ({
          state: `the ${label.toLowerCase()} field asks for`,
          text: label,
        })),
        { state: "the button at rest", text: DETAILS_COPY.confirm },
        { state: "the booking is being made", text: DETAILS_COPY.confirming },
        { state: "it has been running a while", text: DETAILS_COPY.stillWorking },
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
        // #2310: the time is not taken, it is outside the lead's calling hours,
        // so it must not borrow the line above.
        {
          state: "the time starts outside the lead's calling hours",
          text: BOOKING_ERROR_COPY.outsideCallingHours,
        },
        // #3364: read these directly below `slotTaken`. The first is what a lead refused
        // for taken times meets on their next pick, so it says how long and what then;
        // the second is the longer caps, which must not promise a minute.
        {
          state: "too many confirms from their network inside a minute",
          text: BOOKING_ERROR_COPY.tooManyTriesJustNow,
        },
        {
          state: "too many confirms from their network or their contact inside an hour",
          text: BOOKING_ERROR_COPY.tooManyTries,
        },
        { state: "anything else", text: BOOKING_ERROR_COPY.generic },
        // #3359: a detail they typed was refused, by our check or by Google at the
        // calendar. The banner, and the sentence the email field shows under it.
        { state: "a detail they typed was refused", text: BOOKING_ERROR_COPY.checkContactDetails },
        { state: "the email field, when the address cannot be invited", text: INVALID_EMAIL },
        { state: "moving an existing call failed", text: BOOKING_ERROR_COPY.moveFailed },
        // #3373: a move refused because Google will not invite the address the
        // booking already holds. Shown on the manage page too, which has no email
        // field, so it names the reason and offers no action.
        {
          state: "a move whose invite Google refused for the stored email",
          text: BOOKING_ERROR_COPY.moveEmailRefused,
        },
        // #2297: the two refusals the kill switch produces. They share a status code
        // and must not share a sentence: one is somebody holding bookings on purpose
        // and cannot be waited out, the other clears itself.
        { state: "booking has been stopped by hand", text: BOOKING_ERROR_COPY.bookingsPaused },
        {
          state: "we could not read whether booking is stopped",
          text: BOOKING_ERROR_COPY.bookingPauseUnreadable,
        },
        // #2373: read this one directly above `slotTaken`. That is a lost race, and it
        // names the action the lead can take; this is the write not running, and it
        // must not borrow those words, because nothing they choose repairs it.
        {
          state: "the cancel or the move did not run at all, so nothing changed",
          text: BOOKING_ERROR_COPY.writeFailed,
        },
        // #2667: the link's code names no bucket, or one the public may not book.
        // Read it beside `generic` above: this one names the link and claims no
        // fault of ours, where that one used to answer for it.
        {
          state: "the booking link's code names no bucket the public can book",
          text: BOOKING_ERROR_COPY.unknownBucket,
        },
      ],
    },
    {
      screen: "Booker and manage: a test booking",
      purpose:
        "The public test bucket (#2660) lets a partner walk the embed end to end " +
        "without booking a real advisor. Every surface a test booking reaches says so " +
        "in this one sentence, in the treatment reserved for it: the booker on every " +
        "screen, the panel for a call they already have, the manage page, the invite, " +
        "and the mark beside the booking in the admin. Read it as the tester will, and " +
        "as a lead who landed on a test page by mistake would.",
      lines: [
        { state: "the mark beside a test booking", text: TEST_MODE_COPY.label },
        { state: "the sentence on every screen", text: TEST_MODE_COPY.line },
        // #3424: the demo bucket draws the same band in its own words.
        { state: "the word on a demo booking's band", text: DEMO_MODE_COPY.label },
        { state: "the sentence on every screen of a demo booking", text: DEMO_MODE_COPY.line },
      ],
    },
    {
      screen: "Booker: the page could not load",
      purpose:
        "The booker's own error boundary (#2754), drawn when the booker page itself " +
        "fails: a read the page depends on, or a crash anywhere inside it, the " +
        "confirmation screen included. It cannot tell which, so it may not promise that " +
        "nothing was booked. It shipped with the staff sentence about saving a change " +
        "because this state was never read cold.",
      lines: [
        { state: "the heading", text: BOOKER_BOUNDARY_COPY.heading },
        { state: "what happened and what to do", text: BOOKER_BOUNDARY_COPY.body },
        { state: "the button", text: BOOKER_BOUNDARY_COPY.retry },
        {
          state: "the reference, when the error carries a digest",
          text: boundaryReference("1234567890") ?? "",
        },
      ],
    },
    {
      screen: "Booker: a test booking that cannot be opened",
      purpose:
        "The public test bucket opens only for a page on an approved website, carrying a " +
        "short lived pass (#2666). The reader is a TESTER, never a lead, so each cause " +
        "gets its own sentence naming the thing they can act on: open it from their own " +
        "button, ask us to add the website, reload, or tell us it is switched off.",
      lines: [
        { state: "the heading over every refusal on the page", text: TEST_ACCESS_COPY.heading },
        { state: "a demo link opened through somebody's website (#3424)", text: TEST_ACCESS_COPY.demoPageOnly },
        { state: "the page arrived with no referer", text: TEST_ACCESS_COPY.noReferer },
        {
          state: "a website that is not on the approved list",
          text: TEST_ACCESS_COPY.unlistedOrigin("https://staging.example.com"),
        },
        { state: "no website is approved at all", text: TEST_ACCESS_COPY.listEmpty },
        { state: "the deployment holds no signing secret", text: TEST_ACCESS_COPY.secretUnset },
        { state: "the pass ran out while the page sat open", text: TEST_ACCESS_COPY.passExpired },
        { state: "the pass was missing or altered", text: TEST_ACCESS_COPY.passRefused },
        { state: "the secret went away while the page was open", text: TEST_ACCESS_COPY.passOff },
      ],
    },
    {
      screen: "Booker: an advisor's own booking link",
      purpose:
        "The link an advisor sends a lead for a later call with them (#2073). It books " +
        "that one advisor and nobody else, and never reroutes on its own. The " +
        "refusal is ONE sentence whatever the cause (a link that never existed, one " +
        "replaced, an advisor who left or is not taking calls), so the page cannot say " +
        "which, and EVERY refusal carries the same button to the ordinary booker " +
        "(#2831), so the lead chooses. An empty week names the advisor rather than " +
        "every time being taken.",
      lines: [
        { state: "the link books nobody, whatever the cause", text: AGENT_LINK_COPY.unavailable },
        { state: "the button beneath every refusal", text: AGENT_LINK_COPY.bookAnother },
        { state: "the advisor has no open time in the window shown", text: AGENT_LINK_COPY.noTimes },
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
        { state: "when it is", text: confirmedWhen(DAY_FULL, TIME, ZONE_LABEL) },
        // #2165: who will call, and the same sentence without a name, because the
        // confirmation renders before anything guarantees the booking holds one.
        { state: "who will call", text: confirmedAdvisor("Dana Lee") },
        { state: "who will call, when we hold no advisor name", text: confirmedAdvisor(null) },
        { state: "the invite", text: inviteOnItsWay(EMAIL) },
        {
          state: "the invite, with no address to name",
          text: inviteOnItsWay(""),
        },
        { state: "the link onward", text: CONFIRMED_COPY.manageLink },
        {
          state: "what is announced",
          text: confirmedAnnouncement(DAY_FULL, TIME, ZONE_LABEL),
          screenReaderOnly: true,
        },
      ],
    },
    {
      screen: "Booker and manage: add it to your calendar",
      purpose:
        "The four buttons under the confirmation and on the manage page (#2165), one " +
        "component at both sites. Not drawn for a cancelled call, nor for a weak match " +
        "whose time is withheld (#1340).",
      lines: [
        { state: "the heading over the four", text: ADD_TO_CALENDAR_COPY.heading },
        { state: "Google", text: ADD_TO_CALENDAR_COPY.google },
        { state: "Outlook.com", text: ADD_TO_CALENDAR_COPY.outlook },
        { state: "Office 365", text: ADD_TO_CALENDAR_COPY.office365 },
        { state: "the ICS file, for Apple and every other calendar app", text: ADD_TO_CALENDAR_COPY.ics },
        {
          state: "after each of the three that open a new tab",
          text: ADD_TO_CALENDAR_COPY.newTab,
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
          text: duplicateSetFor(`${DAY_FULL} at ${TIME}`),
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
        // Abbreviated, because the panel builds this one from `shortDay`: the time
        // named here is one the lead just tapped out of a list that spells days the
        // same abbreviated way, not a commitment being read back. The preview used
        // the long form, so it showed a sentence the product does not produce.
        { state: "a time is chosen", text: moveToTime(`${DAY_SHORT} at ${TIME}`) },
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
        // The panel builds this from the same `longDay` the line above it uses, so
        // it carries the year too (#2205).
        { state: "what it costs, naming the call", text: cancelConsequenceFor(`${DAY_FULL} at ${TIME}`) },
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
        { state: "the heading, which says the state rather than the advisor and the date", text: LIVE_COPY.heading },
        { state: "what the call is", text: LIVE_COPY.whatLabel },
        { state: "when it is", text: LIVE_COPY.whenLabel },
        { state: "and when, spelled with the year like every other readback", text: callWhen(DAY_FULL, TIME, 20) },
        { state: "the lead's own row", text: LIVE_COPY.youLabel },
        { state: "the number we hold", text: advisorWillCall(PHONE) },
        { state: "no number on the booking", text: advisorWillCall(null) },
        // #1334: said only when Salesforce holds it; otherwise nothing at all.
        { state: "the number the call will come from, when it is known", text: callComesFrom(CALLING_NUMBER) ?? "" },
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
        { state: "the heading over the times", text: RESCHEDULE_COPY.pickReady },
        { state: "the commit, naming the time chosen", text: moveToTime(`${DAY_SHORT} at ${TIME}`) },
        // #2605: said by the commit when the reason is missing, rather than the
        // control sitting there dead. It is `validateReason`'s own sentence, the
        // same one the server answers with, so there is one wording for one rule.
        {
          state: "pressed with no reason chosen",
          text: reasonRefusal({ code: "", detail: "" }),
        },
        {
          state: "pressed on Other with nothing typed",
          text: reasonRefusal({ code: "other", detail: "" }),
        },
        { state: "the time they pressed", text: RESCHEDULE_COPY.moving },
        { state: "nothing is offered", text: rescheduleNoTimes({ from: "pool", advisorName: ADVISOR }) },
        // #2827: a call booked through an advisor's own link moves only within
        // that advisor's times, so an empty week names them rather than "all".
        {
          state: "an advisor link call, and the advisor has nothing left",
          text: rescheduleNoTimes({ from: "advisor", advisorName: ADVISOR }),
        },
        {
          state: "the same, with no advisor name to give",
          text: rescheduleNoTimes({ from: "advisor", advisorName: null }),
        },
        { state: "the times for moving it could not be offered at all", text: RESCHEDULE_COPY.unavailable },
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
      screen: "Manage: the link found no booking",
      purpose:
        "The end of the road for a lead whose link is stale, mistyped or truncated, " +
        "so the one instruction on it has to name something that really exists. It " +
        "named a confirmation email from Pennie for months, and Pennie sends none " +
        "(#64, #2364): the link lives in the calendar invitation the advisor sent.",
      lines: [
        { state: "what happened", text: NOT_FOUND_COPY.heading },
        { state: "why it may have happened", text: NOT_FOUND_COPY.causes },
        { state: "what to do about it", text: NOT_FOUND_COPY.recovery },
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
        // #3376: both people, the way cal.com's invite reads.
        {
          state: "the title",
          text: eventSummary({ eventType: "Senior Loan Advisor Call", advisor: "Sam Ortiz", lead: "Dana Lee" }),
        },
        {
          state: "the title when we hold no advisor name",
          text: eventSummary({ eventType: "Senior Loan Advisor Call", advisor: null, lead: "Dana Lee" }),
        },
        {
          state: "the title when we never got the lead's name",
          text: eventSummary({ eventType: "Senior Loan Advisor Call", advisor: "Sam Ortiz", lead: null }),
        },
        // The number as stored, which is what the advisor sees after the time and
        // taps to dial. A booking with no number has no location at all.
        { state: "the location", text: String(eventLocation(STORED_PHONE)) },
        {
          state: "the body, with the number the advisor will dial",
          text: eventDescription(PHONE, manageUrl),
        },
        {
          state: "and with no number on the booking",
          text: eventDescription(null, manageUrl),
        },
        // #1334: once the reminder lane reads the number the call comes from, it
        // writes it into the invite, so it sits next to the appointment.
        {
          state: "the body once the number we call from is known",
          text: eventDescription(PHONE, manageUrl, { isTest: false, callingNumber: CALLING_NUMBER }),
        },
        // #2660: a TEST booking's invite opens with the test line, so the event
        // on the tester's calendar says what it is without being opened.
        {
          state: "the body of a test booking, which opens with the test line",
          text: eventDescription(PHONE, manageUrl, { isTest: true }),
        },
        // #4206: a call on the placeholder advisor, Marcia, invites from the
        // placeholder seat, whose inbox nobody reads: no number, no manage link, and a
        // question goes to our texts.
        {
          state: "the body of a call on the placeholder advisor, even with the number we call from known",
          text: eventDescription(PHONE, manageUrl, { isTest: false, callingNumber: CALLING_NUMBER, onPlaceholder: true }),
        },
      ],
    },
    {
      screen: "Add to calendar: the lead's own entry",
      purpose:
        "What the four add to calendar buttons on the booking confirmed page put on " +
        "the lead's calendar (#2643), and what the ICS link says for a token we do " +
        "not know (a cancelled call is sent to its manage page instead, #2648). " +
        "Written from the lead's side, naming the advisor who will call.",
      lines: [
        { state: "the title", text: CALENDAR_COPY.title("Dana Lee") },
        { state: "the title when we hold no advisor name", text: CALENDAR_COPY.title(null) },
        { state: "the body", text: CALENDAR_COPY.description(manageUrl) },
        { state: "the ICS link for a token we do not know", text: CALENDAR_COPY.icsNotFound },
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

/**
 * The 24 hour reminder EMAIL (#2495).
 *
 * The only lead-facing surface Slate composes and sends itself rather than handing to
 * Google, and until now the only way to read its wording was to trigger a real send
 * to a real inbox. It is also the message a lead is most likely to REPLY to, because
 * it goes from the advisor's own mailbox and says so, which makes its tone the thing
 * worth looking at.
 *
 * It is not a React component, so the parity test cannot mount it; that is true of
 * the calendar invite above too, and neither needs it. What makes both trustworthy is
 * the rule the whole file rests on: this CALLS `reminderSubject` and `reminderBody`,
 * the very builders the lane sends with, and holds no wording of its own (L41).
 *
 * The states are the ones that read DIFFERENTLY, which is the whole reason the
 * builder takes a clock (#2497). `nowMs` is a fixture here like every other value, so
 * the render is the same at midnight as at noon.
 */
export function reminderCopyScreens(): CopyScreen[] {
  const manageUrl = "https://slate.trypennie.app/booking/manage/8f2c1a";
  const advisor = "Jordan Lee";
  /** The instant the reminder is written AT. The call below is 20 hours later. */
  const REMINDER_NOW_MS = Date.UTC(2026, 7, 16, 22, 0, 0);
  /** A call the day after the reminder, which is the ordinary case. */
  const TOMORROW_ISO = SLOT_ISO;
  /** A call LATER THE SAME DAY, which a booking made inside the window produces: it
   *  is reminded at once, and "tomorrow" would simply be false. */
  const TODAY_ISO = "2026-08-16T23:30:00.000Z";

  const tomorrow = {
    agentName: advisor,
    startsAtIso: TOMORROW_ISO,
    timezone: ZONE,
    manageUrl,
    nowMs: REMINDER_NOW_MS,
    callingNumber: null as string | null,
    /** #4292: the lead's own number, named in the email as the manage page names it. */
    leadPhone: PHONE as string | null,
    onPlaceholder: false,
  };
  /** #4206: a call on the placeholder advisor, sent from the placeholder seat. */
  const onPlaceholder = { ...tomorrow, agentName: "Marcia", callingNumber: CALLING_NUMBER, onPlaceholder: true };
  /** #1334: the number the call will come from, known, with the card attached. */
  const withCallingNumber = { ...tomorrow, callingNumber: CALLING_NUMBER };
  const laterToday = { ...tomorrow, startsAtIso: TODAY_ISO };
  const otherZone = { ...tomorrow, timezone: "America/Los_Angeles" };
  /** #4282: the 1 hour email, written as the lane sends it, just inside the hour. */
  const hourBefore = { ...withCallingNumber, nowMs: Date.parse(TOMORROW_ISO) - 57 * 60_000 };

  return [
    {
      screen: "Reminder email: the call is tomorrow",
      purpose:
        "The one message Pennie composes and sends a lead itself, a day before their " +
        "call, from the advisor's own mailbox. It has to say who is calling and when, " +
        "the number the call comes from when we know it, and how to move it.",
      lines: [
        {
          state: "the subject line, which is most of what gets read",
          text: reminderSubject(tomorrow),
        },
        { state: "the body, when the number we call from is not known", text: reminderBody(tomorrow) },
        // #1334: the number the call comes from, so the lead can save it and get
        // past call screening. The attached card carries that number and no other.
        {
          state: "the body, when the number we call from is known (a contact card is attached)",
          text: reminderBody(withCallingNumber),
        },
        // #4292: no number on file, so the email keeps the manage page's fallback.
        {
          state: "the body, when the booking holds no number for the lead",
          text: reminderBody({ ...tomorrow, leadPhone: null }),
        },
        // #1334 review: no advisor name on the booking. The copy speaks for Pennie
        // rather than showing the advisor's address as a name.
        {
          state: "the body, when the booking holds no advisor name",
          text: reminderBody({ ...withCallingNumber, agentName: null }),
        },
      ],
    },
    {
      screen: "Reminder email: a call on the placeholder advisor, Marcia",
      purpose:
        "A coordinator placed this call on the placeholder because nobody real was free. " +
        "It goes out from the placeholder seat, whose inbox nobody reads, so it names no " +
        "number, attaches no card, offers no way to change the call, and sends a question " +
        "back to our texts (#4206).",
      lines: [
        { state: "the subject line, the same as any reminder", text: reminderSubject(onPlaceholder) },
        { state: "the body, even when the number we call from is known", text: reminderBody(onPlaceholder) },
      ],
    },
    {
      screen: "Reminder email: an hour before the call",
      purpose:
        "The second reminder (#4282), sent beside the lead's one hour text. It is skipped " +
        "when the first reminder went out in the last two hours, for a call booked less " +
        "than an hour ahead, and once the call is under 30 minutes away (#4287).",
      lines: [
        { state: "the subject line", text: hourReminderSubject(hourBefore) },
        { state: "the body, when the number we call from is known", text: hourReminderBody(hourBefore) },
        {
          state: "the body, for a call on the placeholder advisor",
          text: hourReminderBody({ ...hourBefore, agentName: "Marcia", onPlaceholder: true }),
        },
      ],
    },
    {
      screen: "Reminder email: the call is later today",
      purpose:
        "A booking made inside the 24 hour window is reminded at once, so this arrives " +
        "alongside the calendar invite and must not claim the call is tomorrow. Worth " +
        "reading beside the one above: the two differ by one word that would be " +
        "plainly false if it were wrong.",
      lines: [
        { state: "the subject line", text: reminderSubject(laterToday) },
        { state: "the body", text: reminderBody(laterToday) },
      ],
    },
    {
      screen: "Reminder email: a lead in another timezone",
      purpose:
        "The time is spelled in the LEAD's zone and carries it, because an email is " +
        "read away from the page that set it and nothing else on screen says which " +
        "clock it is in.",
      lines: [
        {
          state: "the subject line, with the zone the lead chose",
          text: reminderSubject(otherZone),
        },
      ],
    },
  ];
}

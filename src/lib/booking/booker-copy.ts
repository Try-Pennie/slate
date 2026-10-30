/**
 * Every sentence the BOOKER says to a lead, as pure builders (#1343).
 *
 * Why this file exists. The 2026-08-07 design session was largely a person
 * reading one screen at a time and catching wording by eye: a policy sentence
 * that made the panel about us, a message that said "pick another" without
 * saying another what, dates in British order, a pronoun we cannot know, two
 * sentences running together on one line. All of it was found by clicking
 * through a mockup, and none of it could have been found by reading the code.
 *
 * Slate already solved that for alerts: `pnpm preview:alerts` prints every alert
 * in each state that reads differently, and the rule that makes it trustworthy is
 * that the preview CALLS the real copy builders and never holds its own copy
 * (L41). A preview showing text that is not what ships would be worse than no
 * preview.
 *
 * `pnpm preview:booker` does the same for the surfaces that actually reach
 * customers, and it can only do that if the copy is reachable WITHOUT rendering
 * React. Hence pure builders here, the way the `alert-copy.ts` modules already
 * work.
 *
 * The rule for anything added here: a string a lead can read belongs in this
 * file, not inline in the component. The component keeps the markup (a link, a
 * tabular-nums span, a heading level); this keeps the words.
 *
 * No `@/` imports beyond Luxon, so scripts can drive it node-natively.
 */
import { DateTime } from "luxon";
import type { PhonePrefillDrop } from "../phone-format.ts";
import { formatLongDate } from "../date/parse.ts";
import { callingWindowLabel } from "./lead-calling-window.ts";
import { zoneLabel } from "./timezones.ts";

/**
 * US order everywhere: "Monday, August 17", never "17 August" (#1336).
 *
 * The rule lives in `formatLongDate` now rather than in this comment beside a
 * second copy of it (#2221). `@/lib/date/parse` imports nothing but Luxon, so
 * the no-alias rule above still holds and scripts can still drive this natively.
 */
export function longDayLabel(iso: string, zone: string, opts?: { year?: boolean }): string {
  return formatLongDate(DateTime.fromISO(iso, { zone }), opts) ?? "";
}

// --- the times panel ---------------------------------------------------------
// Moved here from SlotTimes so one surface's copy is not readable while its
// neighbour's is not. `dayEmpty` names the day AND says "above", because "pick
// another" on its own never said another what.

/**
 * The inline card on a landing page (#3718), as settled in
 * docs/design/inline-booker.html: the card's title, and a label over the day
 * strip and times. The Call me now row's own words are `CALL_ME_NOW_COPY` below.
 */
export const INLINE_CARD_COPY = {
  title: "Connect with your loan advisor:",
  chooseTime: "Choose a time for your call below:",
  /**
   * The zone the times are in, under them (Dan, 2026-10-14): the card has no zone
   * picker, so it names the zone in the booker's own words (`zoneLabel`).
   */
  timesIn: (zone: string) => `Times in ${zone}`,
};

/**
 * The inline card's Call me now row and what follows a press (#3718), settled in
 * design rounds 1 to 3 (docs/design/inline-booker.html). The confirmation is
 * trypennie.com's own (its /my-offers/call-me-now page), word for word, bar the one
 * dash in its text message, which Slate's copy rules refuse.
 */
export const CALL_ME_NOW_COPY = {
  ready: "Ready to speak now?",
  haveCall: "Have an advisor call you.",
  button: "Call me now",
  /** The button's label while the press is in flight. */
  pressing: "Requesting your call",
  thanks: (firstName: string | null): string => (firstName ? `Thanks, ${firstName}!` : "Thanks!"),
  momentarily: "You will receive a call momentarily from your advisor.",
  expect: "Here is what you should expect on the call:",
  steps: [
    { title: "Complete income verification call", body: "Verify financial information to ensure accuracy" },
    {
      title: "Review terms and rates with loan advisor",
      body: "Carefully review the offer terms and rates to make sure they meet your needs",
    },
    { title: "Accept and get funded!", body: "That's it. Accepted offers fund as soon as the next business day." },
  ],
  textHeading: "Connect with us via text",
  textBody: "Text us to receive important call and offer information.",
  textButton: "Text us",
  /** The message the Text us link starts. trypennie's has a dash; this one has a full stop. */
  textMessage: "Hi, I just requested a call. Here is the number to reach me.",
  instead: "Rather pick a time?",
  insteadLink: "Choose a time instead",
  failedHeading: "We couldn't request your call right now.",
  /**
   * Points at the times, which sit on the other side of the row from where the page
   * put it: a row above the times says below, a row below them says above.
   */
  failedBody: (rowPosition: "above" | "below"): string =>
    `Choose a time ${rowPosition === "above" ? "below" : "above"} and your advisor will call you then.`,
  tryAgain: "Try again",
};

export const PICKER_COPY = {
  pickADay: "Pick a day above to see the times available.",
  /** #3718: the inline card shows the first few times and offers the rest. */
  viewMore: "View more times",
  /**
   * #3718: the pop up a times piece opened for a time somebody else booked in the
   * moment between. It opens on that time's day instead of the details step.
   */
  pickedTimeGone: "That time was just taken. Pick another below.",
  loading: "Finding the days you can book.",
  failed: "Could not load available times. Check your connection.",
  dayEmpty: (day: string) => `Nothing left on ${day}. Pick another day above.`,
  /**
   * #2310: the day has free times, and every one of them starts before 8:00am or
   * at 8:00pm or later on the lead's own clock, so none can be offered. Said
   * rather than drawn as an empty day, which would read as fully booked. The
   * hours come from the rule's own constant, so the sentence cannot name a
   * window the gate does not enforce.
   */
  outsideCallingHours: (day: string) => {
    const { from, to } = callingWindowLabel();
    return `We only call between ${from} and ${to} your time, and the times left on ${day} are all outside those hours. Pick another day above.`;
  },
  /**
   * The same state on the ADMIN reschedule panel (#2310, L659). The reader is
   * staff and the clock is the lead's (the zone the booking was made in), so
   * "your time" would be false there: it names the lead's zone instead.
   */
  outsideCallingHoursForStaff: (day: string, leadZone: string) => {
    const { from, to } = callingWindowLabel();
    return `We only call leads between ${from} and ${to} their time. This lead is on ${zoneLabel(leadZone)}, and every time left on ${day} is outside those hours for them. Pick another day above.`;
  },
} as const;

/** What assistive tech hears when a day's times settle (#633). */
export function timesAvailableAnnouncement(count: number, day: string): string {
  return `${count} time${count === 1 ? "" : "s"} available on ${day}`;
}

// --- the empty / closed panel (#1328, #1329, #1339) --------------------------
// "All times are taken right now. Check back soon." is untrue in BOTH halves when
// the office is simply shut: nothing is taken, we are shut, and soon may be a
// week. Each cause gets its own sentence.

export function allTimesTaken(): string {
  return "All times are taken right now. Check back soon.";
}

/**
 * The bucket has NOBODY in it (#2158).
 *
 * "All times are taken" is untrue in both halves here: nothing is taken, and soon
 * may be never. It says nobody is available rather than naming a reason, because
 * the reason is ours (a bucket nobody has staffed) and is not the lead's to carry.
 * No "check back", because nothing about this state changes on its own and telling
 * somebody to come back to the same screen tomorrow is the failure #1328 was
 * written about.
 */
export function noAdvisorsAvailable(): string {
  return "We do not have anyone available to book right now. Please try again later.";
}

export function closedUntil(reopensOnIso: string, zone: string): string {
  return `We are closed until ${longDayLabel(reopensOnIso, zone)}.`;
}

export function closedNoReopenDate(): string {
  return "We are closed right now.";
}

/**
 * What follows the closure sentence, when we know the day we are back (#1339).
 *
 * Two sentences doing two jobs. The first stops a lead hunting for a nearer time
 * that is not there; the second tells them there IS a way through, which is the
 * whole reason this state exists rather than "check back soon".
 *
 * Shown ONLY alongside `closedUntil`. "Before then" needs a `then` to refer to, so
 * it would be a dangling sentence under "We are closed right now", and under "All
 * times are taken" it would be false: that week is staffed, it is simply full.
 */
export const CLOSED_BODY = "Nobody is available before then. You can still book the first days back.";

/**
 * The window came back empty and nothing said WHY (#1414).
 *
 * The third empty state, and it is neither of the other two. `emptyBecause` is set
 * by the server whenever it CAN tell, so its absence means an older response shape
 * or a classifier that did not run, and reporting that as "all times are taken"
 * claims a measurement nobody made.
 *
 * It also is NOT the load failure, whatever it may feel like. The read succeeded.
 * Telling this lead to check their connection would be false, would send them to
 * restart a router over a server side gap, and is exactly the claim L11 forbids: a
 * message may say only what its check actually established. What we established is
 * that we do not know.
 */
export const UNCLASSIFIED_EMPTY_NOTICE =
  "We could not work out what is available right now. Please try again in a moment.";

/** The way out of it. Named separately so the button and the sentence cannot drift. */
export const UNCLASSIFIED_EMPTY_RETRY = "Try again";

// --- looking further ahead (#1329, #1364) ------------------------------------

export const NEXT_DAYS_COPY = {
  /** The button at rest. */
  ask: "See our next available days",
  /** While the search runs. The bobbing dots carry it visually; this carries it
   *  for anyone who cannot see them. */
  looking: "Looking…",
  /** Still ALIVE, distinct from started: this search walks up to eight windows,
   *  each doing real calendar work per bookable agent. */
  stillLooking: "Still looking… this is taking longer than usual.",
  /** Could not look, which is a different screen from having looked and found
   *  nothing. This one is for a request that never landed, so trying again is
   *  advice that can actually work. */
  failed: "Could not look further ahead. Check your connection.",
  /** #2155: the reply arrived, said 200, and carried something this page cannot
   *  read. Trying again gets the same reply, so the advice has to differ: the
   *  commonest cause is a page older than the server it is talking to, and a
   *  reload fixes that. Telling this lead to check their connection would send
   *  them to do a thing that cannot work (L11). */
  unreadable: "Something went wrong looking further ahead. Please reload the page and try again.",
  retry: "Try again",
  /** Looked, and there is genuinely nothing to offer. */
  foundNothing: "We could not find a day to offer yet. Please check back.",
} as const;

// --- the details step --------------------------------------------------------

export const DETAILS_COPY = {
  /**
   * What this screen is for, said once, at the top of it (#2361).
   *
   * Measured against cal.com on 2026-09-15: its confirm step is headed
   * ("Confirm your details") and states the booking in full underneath. Slate's
   * had no heading at all, so the highest intent screen in the product was also
   * the only one that did not say what it was.
   *
   * It names the CALL rather than the details, because the fields are labelled
   * for themselves and a title over them saying they are details would be a
   * sentence about the interface (L604). The button below names the act; this
   * names the screen, so neither is the other said twice (L605).
   */
  heading: "Confirm your call",
  confirm: "Confirm booking",
  confirming: "Booking your call…",
  /** The middle of the three states every time-taking action must keep distinct. */
  stillWorking: "Still working… this is taking longer than usual.",
  /**
   * The lead's own number, read back on the event panel. It says nothing about
   * the call: the agent is not chosen until confirm, so the panel cannot honestly
   * claim anything about who dials (#1333).
   *
   * Shown only while a time is being PICKED (#2208). Once the details step is
   * open the Phone field carries the same number, and the field is the one the
   * lead can correct, so the panel's row stands down rather than stating it twice
   * on one screen (L605). It stays for the picking step because a lead the link
   * identifies now arrives with a number filled in, and that step has no field.
   */
  yourNumber: "Your number:",
  /**
   * What each field asks for (#2362).
   *
   * They were built in the component by capitalising the state key, which made
   * them the one set of lead facing words the preview could not show and the one
   * set nobody could read before shipping. The NAME is now two fields, the way
   * cal.com asks, so the first name is answered rather than derived; the last is
   * optional, so somebody with one name is not refused.
   */
  fields: {
    firstName: "First name",
    lastName: "Last name",
    email: "Email",
    phone: "Phone",
  },
} as const;

/**
 * The chosen time, stated in full on the screen that commits to it (#2361).
 *
 * It said "Tue 15" and a time, under no heading, while the weekday, the month
 * and the year lived nowhere on the step. The YEAR is the one that matters most
 * and is easiest to argue away: a lead booking in late December is choosing
 * between two years on a day strip whose chips carry a weekday, a day number and
 * a month, and nothing else on the page names one.
 *
 * It does NOT state the DURATION, although cal.com's step does. The event panel
 * states it on this same composed screen, in both layouts, so a second copy here
 * would be one fact said twice on one surface (L605). Read the page, not the
 * component.
 *
 * It does not name the timezone either, for the same reason twice over: the zone
 * picker sits above the day strip on this step and the event panel names it again
 * below.
 */
export function chosenWhen(day: string, time: string): string {
  return `${day} at ${time}`;
}

/**
 * Why the phone field is empty when the lead arrived with a number (#1356).
 *
 * Dan's decision: Pennie can only CALL a US number, so a prefill that is not one
 * is dropped. The field caps at ten digits, so they cannot type the dropped number
 * back either, and an empty field with no explanation sends them to press confirm
 * and be told "enter your phone number", which is true and useless.
 *
 * It offers no alternative route on purpose (Dan, 2026-08-12): there is no Pennie
 * phone number recorded anywhere in the product, and inventing one to make the
 * sentence feel more helpful would be worse than being brief and true.
 */
export const US_ONLY_PHONE_NOTICE = "We can only call a US number. Please enter one.";

/**
 * Why the field is empty when the number they arrived with had an extension
 * (#1425).
 *
 * A lead who ARRIVED with an extension has done nothing at all, so the sentence
 * leads with why the field they expected to be filled is empty and then asks.
 *
 * This is the ONLY place an extension is named to a lead. A number they typed or an
 * integration posted is refused with `US_ONLY_PHONE_NOTICE`, the same sentence a
 * number we cannot call gets (Dan, 2026-08-12: one refusal sentence rather than one
 * per cause). Here it is still worth naming, because this lead is being asked why a
 * field they expected to be filled is empty, and "we can only call a US number"
 * would be no answer at all to somebody whose number is American.
 */
export const EXTENSION_PHONE_PREFILL_NOTICE =
  "The number we had for you has an extension. Please enter it without one.";

/**
 * Why the phone field is empty when the number they arrived with was UNFINISHED
 * (#1409).
 *
 * Its own sentence, because the US-only one would be the wrong explanation: this
 * lead's number is not foreign, it is short, and telling them about country codes
 * sends them looking for a problem they do not have (L11).
 *
 * It is also the gentler case in consequence, and says so by asking rather than
 * ruling: the field holds ten digits, so unlike a dropped international number
 * this one really can be typed straight back in.
 */
export const INCOMPLETE_PHONE_NOTICE =
  "The number we had for you looks incomplete. Please enter your full number.";

/** The sentence for a given drop, so a caller cannot pair the wrong one with the
 *  right reason. Returns null when nothing was dropped and nothing is owed. */
export function phonePrefillNotice(dropped: PhonePrefillDrop | null): string | null {
  if (dropped === "not-callable") return US_ONLY_PHONE_NOTICE;
  if (dropped === "incomplete") return INCOMPLETE_PHONE_NOTICE;
  if (dropped === "has-extension") return EXTENSION_PHONE_PREFILL_NOTICE;
  return null;
}

/**
 * The event description, as the paragraphs it was written in (#1335).
 *
 * Dan's copy is a description followed by an ask ("join from somewhere quiet, not
 * while driving"), and the second half is a real instruction that changes how the
 * call goes. Rendered as one block they run together on the one panel a lead reads
 * before committing, and the ask stops reading as an ask.
 *
 * Blank lines separate paragraphs. Leading, trailing and repeated ones produce
 * nothing, so a value stored before the normalising parser existed still renders
 * as clean paragraphs rather than as gaps nobody wrote.
 */
export function descriptionParagraphs(description: string | null | undefined): string[] {
  if (!description) return [];
  return description
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function phoneEchoLine(phone: string): string {
  return `${DETAILS_COPY.yourNumber} ${phone}`;
}

// --- errors on the way through ------------------------------------------------

export const BOOKING_ERROR_COPY = {
  /** The 409 race: somebody else took it while this lead was typing.
   *
   *  It no longer ends in "Please pick another", because #1319 puts the alternatives right
   *  underneath: telling someone to pick another and then showing them which ones reads as
   *  two instructions for one action. The sentence still says plainly what happened, because
   *  the alternatives must be added to the explanation rather than replace it (L10). */
  slotTaken: "That time was just taken.",
  /**
   * #4391: a program lead picked one of the extra times on a day whose extra times have
   * all gone (the placeholder day limit). Its own sentence, never `slotTaken`: that time
   * is not taken by anybody, so "just taken" would be untrue (L11). The picker reloads
   * with that day's real times, which is what "the times below" points at.
   */
  placeholderDayFull: "Those extra times for that day just filled up. Pick one of the times below.",
  /**
   * #2310: the server refused a start outside the lead's calling window. The
   * booker only offers times inside it, so this is reached by a page that sat
   * open across a zone change or a stale embed; it says what the rule is and
   * what to do, and the same sentence answers on the booker and on a move.
   */
  outsideCallingHours: (() => {
    const { from, to } = callingWindowLabel();
    return `We only call between ${from} and ${to} your time. Please pick another time.`;
  })(),
  /**
   * #3364: the confirm's minute window turned this one away. It is the refusal a lead meets
   * after being refused for taken times and picking again, so it must not read as a dead end:
   * it says how long (the window clears inside a minute) and what to do then. "Your network",
   * never "you", because the window is per address and a shared office counts as one.
   */
  tooManyTriesJustNow: "Too many tries from your network just now. Please wait a minute, then try again.",
  /** The hourly and per contact caps, whose windows are longer, so this one does not promise
   *  a minute (L11). The wording the route carried inline before #3364, unchanged. */
  tooManyTries: "Too many booking attempts from your network. Please try again in a few minutes.",
  generic: "Something went wrong. Please try again.",
  /** A detail the lead typed was refused, said once above the form while the field
   *  itself carries what to change. Shared by our own check and by Google refusing
   *  the address at the calendar (#3359), because to the lead they are one thing. */
  checkContactDetails: "Please check your contact details.",
  moveFailed: "Could not move your call. Please try again.",
  /**
   * #3373: a move refused because Google will not invite the email address the
   * booking already holds.
   *
   * Noun free like `writeFailed` below, because the booker's move panel and the
   * manage page share the endpoint. It says nothing changed, which is the fact the
   * reader needs (their call still stands), and names the address as the reason.
   * It offers no action: the manage page has no email field, and "try again"
   * would meet the same refusal (L111).
   */
  moveEmailRefused:
    "We could not send a calendar invite to the email address we have for you, so nothing changed.",
  /** #2297: bookings are deliberately held.
   *
   *  It does NOT say "in a moment", because a pause is lifted by a person deciding to
   *  lift it and nobody can promise when. It also does not say to call us, which the
   *  first draft did: the booker carries no phone number anywhere, so that named an
   *  action the lead has no way to take (L111). "A little later" is the most this can
   *  honestly offer until there is a number on this screen to give them. */
  bookingsPaused:
    "We are not taking bookings online right now. Please try again a little later.",
  /** #2297: the same refusal for a reason nobody chose. A different sentence, because
   *  the instruction really is different: this one clears itself and a retry works,
   *  where the pause above does not (L11). */
  bookingPauseUnreadable: "Something went wrong on our side. Please try again in a moment.",
  /**
   * #2373: the write we tried to make did not run, so nothing moved.
   *
   * The sentence a lead reads when a gated booking write FAILED, as opposed to
   * losing the race. It is deliberately noun free ("nothing changed", never "your
   * call" or "your booking"), because one endpoint serves both surfaces and the
   * booker says call where the manage page says booking.
   *
   * It states that NOTHING CHANGED, which is the fact the old behaviour got
   * exactly backwards: a failed cancel answered ok and the lead was told the call
   * was gone while it stood. And it names no action beyond waiting, because there
   * is none: picking another time repairs a lost race and does nothing at all for
   * a write that never ran, so offering it would send the reader somewhere that
   * cannot help (L111).
   */
  writeFailed:
    "Something went wrong on our side, so nothing changed. Please try again in a moment.",
  /**
   * #2667: the link's booking code names no bucket, or names one the public may
   * not book. It used to fall through to "Something went wrong on our end", a
   * server fault sentence for a client's bad link (L11), and paged on the internal
   * error key for a request anybody can send as often as they like.
   *
   * It names the LINK, because that is the thing that is wrong, and it says what
   * did not happen. It offers no action, because there is none the lead can take
   * here: the link came from a page Pennie does not control, and telling them to
   * try again would send them to the same refusal (L111). One sentence for an
   * unknown code and a hidden test bucket alike, so the wording can never say a
   * hidden bucket exists (#601).
   */
  unknownBucket: "This booking link is not valid, so no call was booked.",
} as const;

/**
 * What to say beneath a refused confirm, alongside the soonest times that are free (#1319).
 *
 * Every state is written out, because the degenerate ones are where a recovery turns back into
 * a dead end and each needs its own words (L22). "Nothing free at all" and "we could not look"
 * are different screens and must never share a sentence (L10, L11).
 */
export const NEAREST_TIMES_COPY = {
  /** While the fresh availability is being fetched. Never an indefinite blank. */
  looking: "Finding the next available times",
  /** Heading above the alternatives. */
  heading: "The soonest times still open",
  /** Under the list, so it is obvious no booking happened on a tap. */
  hint: "Pick one and confirm. Your details are saved.",
  /**
   * The same place, for a lead MOVING a call they already have (#1549): the manage
   * page, and the booker's offer to move an existing call.
   *
   * The wording above promises saved details, which is the reassurance somebody
   * mid-signup needs and the wrong one here. This person already has a booking and
   * has just been refused, so the fact worth putting in front of them is that they
   * have not lost it. Says nothing about what a tap does, because that differs
   * between the two surfaces and is visible on both.
   */
  hintMove:
    "Your call is still booked at its original time. Nothing changes until you choose a new one.",
  /** The re-check worked and there is genuinely nothing left in the bookable window. */
  none:
    "There are no other times open in the next few days. Please try again later, or call us and we will find a time with you.",
  /** The re-check itself failed, which is NOT the same as nothing being free. */
  lookupFailed:
    "We could not load the remaining times just now. Please try again in a moment.",
  /** The retry control on that failure. */
  retry: "Try again",
} as const;

// --- the confirmation ---------------------------------------------------------

export const CONFIRMED_COPY = {
  heading: "You're all set",
  manageLink: "View or manage your booking",
} as const;

/** Built from the confirm step's own join, so the screen a lead commits on and the
 *  screen that confirms it cannot spell one instant two ways (L41). */
export function confirmedWhen(day: string, time: string, zoneLabel: string): string {
  return `${chosenWhen(day, time)} (${zoneLabel})`;
}

/**
 * Who will call (#2165). A call from a named person is harder to ignore than one
 * from an unknown number, so the confirmation names them when the booking holds a
 * name. When it holds none, the sentence still says a person will call, without
 * inventing one: naming nobody is better than naming the wrong somebody (L75). No
 * pronoun, because nothing on the agent record says how a person wants to be
 * referred to.
 */
export function confirmedAdvisor(advisorName: string | null): string {
  return advisorName
    ? `Your loan advisor, ${advisorName}, will call you then.`
    : "Your loan advisor will call you then.";
}

/**
 * The add to calendar group (#2165), drawn on the Booker's confirmation and on the
 * manage page by ONE component, so its words live once. The four links come from
 * `calendarLinks` (#2643); these are only what the buttons are called.
 */
export const ADD_TO_CALENDAR_COPY = {
  heading: "Add it to your calendar",
  google: "Google",
  outlook: "Outlook",
  office365: "Office 365",
  /** The ICS file, which Apple Calendar and most other calendar apps open. */
  ics: "Apple or other",
  /** Read after each of the three that open a new tab, and only by assistive
   *  tech: a tab that opens unannounced reads as the page going nowhere. */
  newTab: "(opens in a new tab)",
} as const;

/** Falls back to a phrase, never to an empty gap: "on its way to ." would read as
 *  a broken sentence rather than a missing address. */
export function inviteOnItsWay(email: string): string {
  return `A calendar invite is on its way to ${email || "your email"}.`;
}

/**
 * The entry a lead adds to their OWN calendar (#2643): the Google, Outlook and
 * Office 365 links and the ICS file all read these. Written from the lead's side,
 * unlike the invite on the advisor's calendar, which names the lead. The advisor
 * is named when we hold the name, because a call from a named person is harder
 * to ignore than one from an unknown number.
 */
export const CALENDAR_COPY = {
  title: (agentName: string | null): string =>
    agentName ? `Pennie call with ${agentName}` : "Pennie call with your loan advisor",
  /** What the ICS link answers for a token we do not know (#2643). A cancelled call
   *  is sent to its manage page instead (#2648), so it needs no sentence here. */
  // Pennie sends no confirmation email (#64, #2364), so the recovery names the
  // calendar invitation the advisor sent, which is where the details really are.
  icsNotFound: "We couldn't find that call. The calendar invitation your advisor sent has its details.",
  description: (manageUrl: string): string =>
    `Your Pennie loan advisor will call you at this time.\nReschedule or cancel: ${manageUrl}`,
} as const;

/** What assistive tech hears on the confirmation (#633). */
export function confirmedAnnouncement(day: string, time: string, zoneLabel: string): string {
  return `Booked. ${day} at ${time} ${zoneLabel}. A calendar invite is on its way.`;
}

// --- the duplicate decision (#1340) -------------------------------------------
// A weak match may be somebody ELSE's booking (a shared household phone, a couple
// on one email), so its time and its manage link are withheld and the lead is
// pointed at the confirmation email they already hold. The copy has to work
// without naming anything.

export const DUPLICATE_COPY = {
  heading: "Heads up: you already have another call booked",
  viewOrCancel: "View or cancel that booking",
  /**
   * The withheld case. Names nothing, hands over no token.
   *
   * It used to point at "the confirmation email we sent you", which Pennie does
   * not send: #64 settled the confirmation as Google's native calendar
   * invitation, from the advisor's calendar. Same correction as the not found
   * screen (#2364), because it was the same sentence in three places (L30).
   */
  checkYourEmail:
    "Check the calendar invitation for that call if you need to view or change it.",
} as const;

export function duplicateSetFor(when: string): string {
  return `It's set for ${when}. If you only need one, you can view or cancel it.`;
}

// --- moving an existing call from the booker ----------------------------------

export const MOVE_COPY = {
  reasonLegend: "Why are you rescheduling?",
  moving: "Moving your call…",
  moveNoTime: "Move my call",
  /**
   * The way on from the LANDING panel (#2166), which has no picked time behind it.
   *
   * A verb phrase for what they came to do, not a dismissal: a lead who opens their
   * link already has a call, and the reason they opened it is that they want a
   * different time. "Close" or "Continue" would make them work out that the picker
   * is still there.
   */
  pickAnotherTime: "Pick another time",
} as const;

/**
 * Cancelling the call the lead already has, from the booker panel (#2167).
 *
 * A lead recognised by their link is the one place the product knows exactly who
 * they are, and it was the one place it withheld the exit: the panel offered move
 * or keep, and cancel lived only on the manage link inside the calendar invite. A
 * lead who lost that email, or never received it, had no way to cancel at all.
 *
 * The words are the booker's, not the manage page's, and that is deliberate rather
 * than duplication. Everything a lead reads here calls it a CALL ("You already have
 * a call booked", "Move my call"), and the manage page calls it a booking
 * throughout. Sharing one set would put the wrong noun on one of the two screens,
 * which is the same defect as having two words for one thing (L118). The ACTION is
 * shared: this goes through the same lead cancel endpoint the manage page uses,
 * with the same mandatory reason.
 */
export const BOOKER_CANCEL_COPY = {
  /** The control that OPENS the confirmation. Never cancels on its own press. */
  start: "Cancel my call",
  heading: "Cancel your call?",
  reasonLegend: "Why are you cancelling?",
  confirm: "Yes, cancel it",
  confirming: "Cancelling…",
  /** The way out, worded as keeping what they have rather than as "no". */
  keep: "Keep my call",
  failed: "Could not cancel your call. Please try again.",
  /** After it is done. They came here to book, so the way on is offered. */
  doneHeading: "Your call is cancelled",
  doneBookAgain: "Book a new time",
} as const;

/**
 * What cancelling costs, naming the call being given up.
 *
 * The specific consequence, not a general one: "this cannot be undone" is true of
 * every cancel anybody has ever confirmed and tells this reader nothing about which
 * call they are about to lose. The panel above names the time, and the sentence
 * inside a destructive confirmation has to stand on its own, because that is the
 * one the reader is deciding from.
 */
export function cancelConsequenceFor(when: string): string {
  return `This gives up your call on ${when}. It cannot be undone.`;
}

/**
 * The booker's half of correcting the number the advisor will ring.
 *
 * The sentence NAMING that number is `advisorWillCall` in manage-copy, called
 * from here rather than written twice (#2213). It used to be its own builder
 * saying four digits, because the panel is reached by the booking link and the
 * manage page by the token inside the lead's own invite; Dan took the whole
 * number on both surfaces, 2026-09-10, so they now say one thing and two
 * spellings of one sentence is what a shared builder exists to prevent (L118).
 *
 * Everything else here is `PHONE_COPY` in manage-copy, reused for the same
 * reason: those sentences name neither a call nor a booking, so the noun split
 * that keeps the cancel copy separate does not apply to them (L41).
 */
export const BOOKER_PHONE_COPY = {
  /**
   * A booking with nobody to ring. It cannot be made through the booker, but it
   * arrives through the API and through an import, and it is a different screen
   * from a number that might be wrong: one asks the lead to check something, the
   * other tells them a call cannot be placed at all (L10).
   */
  noNumber: "We do not have a number to call you on.",
  /** Its own control, because "Not the right number?" asks about a number that
   *  is not there. */
  addTrigger: "Give us a number to call",
} as const;

export function moveToTime(when: string): string {
  return `Move my call to ${when}`;
}

export function keepExistingTime(shortDay: string): string {
  return `Keep my ${shortDay} time`;
}

/**
 * What a move ALSO changed, when the lead typed different details on the way to it
 * (#2164).
 *
 * A lead's commonest reason to come back to their link is that the details they
 * gave first were wrong, so the move carries the new ones onto the call. Saying so
 * is the other half of that: an action that quietly applies part of what somebody
 * asked for is one they cannot check, and the only way to find out would be to
 * wait for a call that never comes (L608).
 *
 * Null when nothing moved, so the screen shows no line rather than a sentence
 * claiming a change nobody made.
 *
 * IT DOES NOT SAY WHERE THE CONFIRMATION IS GOING, and the first draft did. Read
 * on the rendered screen, that sentence sat directly under "A calendar invite is
 * on its way to new@example.com", so the address appeared twice in two lines and
 * the second one told the reader nothing the first had not (L605). The line above
 * is built from the address they just typed, which is the corrected one, so it is
 * already right.
 */
export function movedContactNote(changed: {
  name: boolean;
  email: boolean;
  phone: boolean;
}): string | null {
  const parts = [
    changed.name ? "name" : null,
    changed.email ? "email address" : null,
    changed.phone ? "phone number" : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `We have updated your ${list} for this call.`;
}

// --- test mode (#2660) ---------------------------------------------------------
//
// The public test bucket lets a partner walk the embed end to end from their own
// site without booking a real advisor. The booking is real everywhere a tester can
// see (a time is held, an invite arrives) and reaches nothing downstream, so every
// surface it touches has to SAY so, or a tester cannot tell it from a real booking
// and a stray lead is told a call is coming that never will (L678). One sentence,
// drawn on the booker, the existing call panel, the manage page, the invite and
// the admin's search and detail, in the one treatment reserved for it.

export const TEST_MODE_COPY = {
  /** The word on the mark beside a test booking, wherever it is listed. */
  label: "Test",
  /** The whole sentence, on every screen a tester or a stray lead reads. It names
   *  what happens (a test calendar) and what does not (a text), which is the
   *  domain, not the interface (L604). */
  line: "This is a test booking. It reaches a test calendar only and sends no texts.",
} as const;

/**
 * The same band on the demo bucket (#3424), which somebody outside Pennie reaches
 * through the `/demo` link. Its bookings cancel themselves 30 minutes after they
 * are made, so the sentence says that, and a visitor who opens the manage page to
 * a cancelled call has already been told why. Wording agreed with Dan, 2026-10-06.
 */
export const DEMO_MODE_COPY = {
  label: "Demo",
  line: "This is a demo. Your booking is cancelled automatically and nobody is contacted.",
} as const;

// --- who may open a test booking (#2666) ------------------------------------------
//
// The public test bucket is served only to host pages on an approved website, and
// only while the page's short lived pass is good. The reader here is a TESTER (a
// partner or somebody at Pennie), never a lead, so these sentences name websites
// and reloading, the things a tester can act on. One sentence per cause, because
// each sends the reader somewhere different (L11): three are ours to fix, one is
// theirs, and a pass that ran out is fixed by a reload.

export const TEST_ACCESS_COPY = {
  /** The heading over every refusal on the page itself. The cause is the body. */
  heading: "Test bookings are not available here",
  /** The page arrived with no Referer, so which website framed it is unknown. */
  noReferer:
    "We could not tell which website opened this test booking. Open it from the booking button on your website.",
  /** A website that is not on the approved list. Names it, so the tester can
   *  tell us exactly which one to add. */
  unlistedOrigin: (origin: string) =>
    `Test bookings are not turned on for ${origin}. Ask Pennie to add this website.`,
  /** The demo bucket (#3424), asked for through a host page. It opens only from
   *  its own link, so that is what the reader is sent back to. */
  demoPageOnly: "This demo opens only from its own link. Open the demo link you were sent.",
  /** The deployment approves no website at all. */
  listEmpty: "No website is approved for test bookings yet. Ask Pennie to add yours.",
  /** The deployment holds no signing secret, so no pass can be made or checked. */
  secretUnset: "Test bookings are turned off on our side right now. Please let Pennie know.",
  /** A pass that ran out while the page sat open: a modal left open past its
   *  expiry, found at the confirm or at a later read of the times. */
  passExpired: "This test page was open too long to book from. Reload the page to keep testing.",
  /** A pass that is missing, altered, or made for a different bucket. */
  passRefused: "We could not confirm this test page. Reload the page to keep testing.",
  /** The secret went away while the page was open, so its pass cannot be checked. */
  passOff: "Test bookings were turned off while this page was open. Please let Pennie know.",
} as const;

// --- an agent's own booking link (#2073) --------------------------------------
//
// A link an agent sends for the later calls with a lead who is already theirs. It
// books that one advisor and nobody else, so it has no pool to fall back on.

export const AGENT_LINK_COPY = {
  /**
   * The link books nobody. ONE sentence for every cause: a token that never
   * existed, one an admin replaced, an advisor who has left, and one who is not
   * taking calls. A second sentence for any of them would let the page be used to
   * learn whether a link was ever real, or who is still on the roster.
   */
  unavailable: "This advisor is not taking bookings through this link right now.",
  /**
   * The way on beneath that sentence (#2831): the ordinary booker, where any
   * advisor on the team can take the call. On EVERY refusal, so its presence
   * says nothing about the link either.
   */
  bookAnother: "Book with another advisor",
  /** The advisor is taking bookings and has no open time in the window shown.
   *  Names the advisor rather than "all times", because there is only one of them. */
  noTimes: "This advisor has no open times in the next few days. Please check back later.",
} as const;

// --- the booker could not load (#2754) ----------------------------------------
//
// What the booker's own error boundary says (`BookerErrorBoundary`, on `/book` and
// `/booking/[id]`). It used the staff boundary's sentence, which tells an admin mid
// edit to check whether their change went through, and read oddly to a lead mid
// booking. The reference line under it stays the shared `boundaryReference`, since
// a digest is the same fact on every surface. The words live in a leaf module with
// no imports, re-exported here, so the boundary can carry them without pulling this
// whole file into the client bundle; that file says what they may claim and why.

export { BOOKER_BOUNDARY_COPY } from "./booker-boundary-copy.ts";

// --- the honeypot (#1033) -----------------------------------------------------
// Read only by a bot, and by a screen reader that ignores aria-hidden containers.
// It is here so the preview shows every string the markup carries, including the
// ones no human is meant to act on.

export const HONEYPOT_LABEL = "Leave this field empty";

// --- privacy, terms, and what giving us a number leads to (#1041) ------------
//
// The 2026-07-23 production readiness audit found the standalone booker
// collecting a name, an email and a phone number for a debt consultation call
// with no privacy policy, no terms, and nothing saying what the number is for.
//
// The EMBEDDED booker inherits Pennie's policies from the trypennie.com page
// around it. The standalone page at slate.trypennie.app/book has no page around
// it, so it inherits nothing, and it is the one a lead can reach directly.
//
// The links are ABSOLUTE and point at trypennie.com, because this booker is
// served from slate.trypennie.app and is also embedded on other pages, so a
// relative path would resolve against whichever host is showing it.

/** Pennie's own legal pages. Taken from that site's sitemap route rather than
 *  guessed: a legal link that 404s says a policy exists and then fails to
 *  produce it, which is worse than not linking one. */
export function legalLinks(): { label: string; href: string }[] {
  return [
    { label: "Privacy policy", href: "https://trypennie.com/privacy-policy" },
    { label: "Terms of service", href: "https://trypennie.com/terms-of-service" },
  ];
}

// #2204 deleted the line that used to sit above the confirm button. It said what
// the button would do and what the field above it was for, which is the screen
// explained back to the reader (L604), and every fact in it was already on the
// step: the heading names the call, the line under it states the time in full,
// the field is labelled Phone and the button says "Confirm booking". Nothing
// legal rested on it, because Slate records no consent anywhere and the sentence
// claimed no agreement. The legal links below are unaffected and stay.

export const LEGAL_COPY = {
  /** Labels the footer for assistive tech, so the links are not two bare words
   *  floating at the bottom of the page. */
  heading: "Legal",
} as const;

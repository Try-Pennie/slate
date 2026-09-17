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

/**
 * US order everywhere: "Monday, August 17", never "17 August" (#1336).
 *
 * The rule lives in `formatLongDate` now rather than in this comment beside a
 * second copy of it (#2221). `@/lib/date/parse` imports nothing but Luxon, so
 * the no-alias rule above still holds and scripts can still drive this natively.
 */
export function longDayLabel(iso: string, zone: string): string {
  return formatLongDate(DateTime.fromISO(iso, { zone })) ?? "";
}

// --- the times panel ---------------------------------------------------------
// Moved here from SlotTimes so one surface's copy is not readable while its
// neighbour's is not. `dayEmpty` names the day AND says "above", because "pick
// another" on its own never said another what.

export const PICKER_COPY = {
  pickADay: "Pick a day above to see the times available.",
  loading: "Finding the days you can book.",
  failed: "Could not load available times. Check your connection.",
  dayEmpty: (day: string) => `Nothing left on ${day}. Pick another day above.`,
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
  confirm: "Confirm booking",
  confirming: "Booking your call…",
  /** The middle of the three states every time-taking action must keep distinct. */
  stillWorking: "Still working… this is taking longer than usual.",
  /** The lead's own number, echoed back as a check on what they typed. It says
   *  nothing about the call: the agent is not chosen until confirm, so the panel
   *  cannot honestly claim anything about who dials (#1333). */
  yourNumber: "Your number:",
} as const;

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
  generic: "Something went wrong. Please try again.",
  moveFailed: "Could not move your call. Please try again.",
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

export function confirmedWhen(day: string, time: string, zoneLabel: string): string {
  return `${day} at ${time} (${zoneLabel})`;
}

/** Falls back to a phrase, never to an empty gap: "on its way to ." would read as
 *  a broken sentence rather than a missing address. */
export function inviteOnItsWay(email: string): string {
  return `A calendar invite is on its way to ${email || "your email"}.`;
}

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
  /** The withheld case. Names nothing, hands over no token. */
  checkYourEmail:
    "Check the confirmation email we sent you if you need to view or change it.",
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

/**
 * The one line above the confirm button.
 *
 * It describes WHAT HAPPENS rather than asserting that the lead has agreed to
 * anything. Slate records no consent anywhere, so copy saying "you agree" or
 * "you consent" would be a claim the product cannot support, and copy is a
 * contract (L21). Booking a call is itself the request to be called, and saying
 * so plainly is both true and the thing the lead actually wants to know.
 *
 * It promises no outcome: Pennie is a lending marketplace and never guarantees
 * one.
 *
 * It says "the number you gave" rather than naming a position on the page. The
 * phone sits in the LEFT column on desktop and above the button on mobile, so
 * "above" is true in one layout and false in the other.
 */
export function contactDisclosure(): string {
  return (
    "Booking this call means a Pennie specialist will phone you on the number " +
    "you gave, at the time you picked."
  );
}

export const LEGAL_COPY = {
  /** Labels the footer for assistive tech, so the links are not two bare words
   *  floating at the bottom of the page. */
  heading: "Legal",
} as const;

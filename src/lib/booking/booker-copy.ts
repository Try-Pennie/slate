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

/** US order everywhere (#1336): "Monday, August 17", never "17 August". */
export function longDayLabel(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone }).toFormat("cccc, LLLL d");
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

export function closedUntil(reopensOnIso: string, zone: string): string {
  return `We are closed until ${longDayLabel(reopensOnIso, zone)}.`;
}

export function closedNoReopenDate(): string {
  return "We are closed right now.";
}

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
   *  nothing. */
  failed: "Could not look further ahead. Check your connection.",
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
export function phonePrefillNotice(dropped: "not-callable" | "incomplete" | null): string | null {
  if (dropped === "not-callable") return US_ONLY_PHONE_NOTICE;
  if (dropped === "incomplete") return INCOMPLETE_PHONE_NOTICE;
  return null;
}

export function phoneEchoLine(phone: string): string {
  return `${DETAILS_COPY.yourNumber} ${phone}`;
}

// --- errors on the way through ------------------------------------------------

export const BOOKING_ERROR_COPY = {
  /** The 409 race: somebody else took it while this lead was typing. */
  slotTaken: "That time was just taken. Please pick another.",
  generic: "Something went wrong. Please try again.",
  moveFailed: "Could not move your call. Please try again.",
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
} as const;

export function moveToTime(when: string): string {
  return `Move my call to ${when}`;
}

export function keepExistingTime(shortDay: string): string {
  return `Keep my ${shortDay} time`;
}

// --- the honeypot (#1033) -----------------------------------------------------
// Read only by a bot, and by a screen reader that ignores aria-hidden containers.
// It is here so the preview shows every string the markup carries, including the
// ones no human is meant to act on.

export const HONEYPOT_LABEL = "Leave this field empty";

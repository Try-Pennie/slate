/**
 * Every sentence the MANAGE PAGE says to a lead, as pure builders (#1343).
 *
 * The sibling of booker-copy.ts, and there for the same reason: the copy that
 * actually reaches customers had no way to be READ before it shipped. See that
 * file's header for the full why. The rule is the same one that makes
 * `pnpm preview:alerts` trustworthy: the preview CALLS these, and never restates
 * them (L41).
 *
 * Two constraints run through this surface and are easy to undo by accident:
 *
 *  - **No pronoun for the advisor, anywhere.** Nothing on the agent record says
 *    how a person wants to be referred to, and a guess misgenders a colleague in
 *    front of a customer.
 *  - **Cancel is never phrased as a peer of reschedule** (#1338). An accidental
 *    cancel costs far more than an accidental reschedule, so the words carry the
 *    asymmetry the layout does.
 *
 * No `@/` imports, so scripts can drive it node-natively.
 */

// --- the live booking ---------------------------------------------------------

export const LIVE_COPY = {
  /** Used when neither the advisor's first name nor a countdown can be built, so
   *  the heading is never empty and never a half sentence. */
  headingFallback: "Your call",
  /** No pronoun: see the header. */
  changeYourPlans: "If your plans change, you can move it or cancel it.",
  reschedule: "Reschedule",
  cancel: "Cancel booking",
  /** The middle of the three states every time-taking action must keep distinct. */
  stillWorking: "Still working… this is taking longer than usual.",
} as const;

/**
 * Who is calling and on what number.
 *
 * Falls back to a phrase rather than to a gap: "will call you at ." reads as a
 * broken sentence, where "the number you gave us" is true and still tells the
 * lead what will happen.
 */
export function advisorWillCall(phone: string | null): string {
  return `Your advisor will call you at ${phone ?? "the number you gave us"}.`;
}

/** The heading: the advisor's first name and the countdown, whichever resolved.
 *  The name is DROPPED when unresolvable rather than replaced with a placeholder. */
export function liveHeading(advisorFirstName: string | null, countdown: string | null): string {
  return [advisorFirstName, countdown].filter(Boolean).join(", ") || LIVE_COPY.headingFallback;
}

// --- before the call ----------------------------------------------------------

export const BEFORE_COPY = {
  heading: "Before the call",
  body:
    "Join from somewhere quiet, not while driving, with access to a screen (phone, " +
    "tablet, laptop, etc.). Some of what we will cover is easier to follow along visually.",
} as const;

// --- confirming a cancel ------------------------------------------------------

export const CANCEL_COPY = {
  heading: "Cancel this booking?",
  /** Says what it costs, in the lead's terms, before they commit. */
  consequence: "This releases your time and cannot be undone.",
  reasonLegend: "Why are you cancelling?",
  confirm: "Yes, cancel it",
  confirming: "Cancelling…",
  /** The way out, worded as keeping what they have rather than as "no". */
  keep: "Keep my booking",
  failed: "Could not cancel. Please try again.",
} as const;

// --- rescheduling -------------------------------------------------------------

export const RESCHEDULE_COPY = {
  reasonLegend: "Why are you rescheduling?",
  /** The heading over the day strip, which changes with whether a reason is set,
   *  so the lead is never left guessing why the times will not respond. */
  pickReady: "Pick a new time",
  pickBlocked: "Choose a reason above, then pick a new time",
  /** On the slot being submitted, so the pressed time is the one that says it. */
  moving: "Moving…",
  /** The only way back out while the panel is open (#1336). */
  keepCurrent: "Keep my current time",
  noTimes: "All times are taken right now. Check back soon.",
  failed: "Could not reschedule. Please try again.",
} as const;

// --- a booking that is over ---------------------------------------------------
// Cancelled and already-happened are DIFFERENT screens: one is a decision the lead
// made and may want to reverse, the other is a call that took place. Offering
// "grab a new time" to somebody whose call just happened reads as though we did
// not notice it happened.

export const DONE_COPY = {
  cancelledHeading: "This booking is cancelled",
  happenedHeading: "This call has happened",
  cancelledBody:
    "Changed your mind? You can grab a new time with the same team whenever you are ready.",
  happenedBody:
    "Need to talk again? You can book another time with the same team whenever you are ready.",
  bookAgain: "Book a new time",
} as const;

export function doneHeading(status: string): string {
  return status === "cancelled" ? DONE_COPY.cancelledHeading : DONE_COPY.happenedHeading;
}

export function doneBody(status: string): string {
  return status === "cancelled" ? DONE_COPY.cancelledBody : DONE_COPY.happenedBody;
}

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
 * Who is calling and on what number, on BOTH surfaces (#2213).
 *
 * The booker's existing call panel says this too, and calls this builder rather
 * than spelling the same sentence its own way. It had its own wording while the
 * panel named four digits and the manage page showed the number whole; Dan took
 * the whole number on both, 2026-09-10, and one sentence said twice is exactly
 * what these files exist to stop (L118).
 *
 * Falls back to a phrase rather than to a gap: "will call you at ." reads as a
 * broken sentence, where "the number you gave us" is true and still tells the
 * lead what will happen. The BOOKER never reaches that fallback: a call carrying
 * no number gets `BOOKER_PHONE_COPY.noNumber` and its own control, because "we
 * cannot call you" is a different screen from "this might be wrong" (L10).
 */
export function advisorWillCall(phone: string | null): string {
  return `Your advisor will call you at ${phone ?? "the number you gave us"}.`;
}

/** The heading: the advisor's first name and the countdown, whichever resolved.
 *  The name is DROPPED when unresolvable rather than replaced with a placeholder. */
export function liveHeading(advisorFirstName: string | null, countdown: string | null): string {
  return [advisorFirstName, countdown].filter(Boolean).join(", ") || LIVE_COPY.headingFallback;
}

// --- correcting the number ----------------------------------------------------
// The number the advisor rings is the most useful fact on this page, and it was
// the only one a lead could not change (#1341). A mistyped digit, an old mobile,
// a work line nobody answers: the call simply fails and is recorded as a no show.

export const PHONE_COPY = {
  /** A control has to look like a control at rest, so this is a visible button,
   *  not a hover affordance (L49). Phrased as the lead's own doubt, because most
   *  leads never need it and should not be invited to fiddle. */
  trigger: "Not the right number?",
  heading: "What number should we call?",
  label: "Phone number",
  /** The booker's own hint, said the same way, because it is the same promise. */
  hint: "So your advisor can reach you.",
  save: "Save this number",
  /** The middle of the three states every time-taking action must keep distinct. */
  saving: "Saving…",
  stillWorking: LIVE_COPY.stillWorking,
  cancel: "Keep the number I have",
  /** A failed save must never leave the new number on screen looking accepted. */
  failed: "Could not save that number. Please try again.",
} as const;

/**
 * Server side refusals for a phone correction. They are copy, so they live here
 * with every other sentence a lead can read, and they are DISTINCT causes: a
 * token that resolves to nothing is not the same as a call that has already
 * happened, and a single "could not save" would flatten both (L11).
 */
export const MANAGE_PHONE_NOT_FOUND =
  "We could not find this booking. Open the link from your confirmation email again.";
export const MANAGE_PHONE_NOT_CHANGEABLE =
  "This call is over, so there is no number left to change. Book a new time whenever you are ready.";

/** The confirmation, naming the number that is now stored rather than the one typed. */
export function phoneSaved(phone: string): string {
  return `Saved. Your advisor will call you at ${phone}.`;
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

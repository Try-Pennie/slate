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

import { formatPhoneForDisplay } from "../phone-format.ts";
import { RESCHEDULE_TIMES_UNAVAILABLE_SENTENCE } from "./reschedule-times-refusal.ts";

// --- the link resolved to no booking ------------------------------------------

/**
 * What a lead reads when their manage link finds nothing (#634, reworded #2364).
 *
 * The screen is the good part and is better than the incumbent's: cal.com answers
 * a dead booking link with a generic 404 offering its own documentation and blog.
 * This one says what happened, why it may have happened, and what to do.
 *
 * The instruction was the wrong part. It said to open "the most recent
 * confirmation email from Pennie", and there is no such email: #64 settled the
 * confirmation as Google's native calendar invitation, sent from the ADVISOR's
 * calendar, and Slate sends nothing else. So a lead searching their inbox for
 * Pennie found nothing, while the link they needed sat in an invitation from
 * somebody they may not recognise by name.
 *
 * The recovery itself was always real: the invite's description carries
 * "Reschedule or cancel: <link>" (`eventDescription` in `booking/core.ts`), which
 * is why the sentence names those words rather than describing them. It names the
 * SENDER too, because "not from Pennie" is the whole reason the old instruction
 * failed, and it says "your advisor" rather than a name or a pronoun: nothing on
 * the agent record says how a person wants to be referred to, and this screen has
 * no booking in scope to read one from anyway.
 *
 * It lives here rather than inline in `ManageNotFound` so it can be read before it
 * ships, like every other sentence a lead can reach (L41).
 */
export const NOT_FOUND_COPY = {
  heading: "We couldn't find that booking",
  causes:
    "The link may have expired, the booking may have already been cancelled, or the " +
    "address might be slightly off.",
  recovery:
    "Look for the calendar invitation your advisor sent for this call. The link to " +
    "reschedule or cancel is in the invitation's details.",
} as const;

// --- the live booking ---------------------------------------------------------

export const LIVE_COPY = {
  /**
   * The heading (#2601).
   *
   * It says the booking's STATE. What it replaced was built from the advisor's
   * first name and a countdown ("Tony, in three days"), which Dan objected to on
   * 2026-09-22 and which was made entirely of two facts the page already carries,
   * the advisor and the date, so it was a duplication rather than only a wording
   * somebody disliked (L605).
   *
   * It needs no fallback, unlike the pair it replaces: a state is always known,
   * where a name and a countdown each had a way of being unresolvable.
   */
  heading: "Your call is booked",
  /** The labels on the detail rows. Named here rather than inline so the preview
   *  can show them and so they cannot drift from the order they render in.
   *
   *  The third is "You" rather than "Who": the advisor is named in the header, so
   *  a row labelled Who whose only value is the lead answers a question the page
   *  has already half answered somewhere else, and reads as though somebody is
   *  missing from it. */
  whatLabel: "What",
  whenLabel: "When",
  youLabel: "You",
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
  // Formatted HERE rather than at each call site (#2616), so a caller handing over
  // the stored `+1XXXXXXXXXX` still produces a sentence written for a person.
  return `Your advisor will call you at ${formatPhoneForDisplay(phone) ?? "the number you gave us"}.`;
}

/**
 * The same fact in the reminder emails' first person (#4292), written by the advisor:
 * the lead's own number, formatted and falling back exactly as `advisorWillCall` does,
 * so the email and the manage page never disagree about what we will dial. No full
 * stop, because each email carries on the sentence in its own way.
 */
export function weWillCallYou(phone: string | null): string {
  const shown = formatPhoneForDisplay(phone);
  return shown ? `We will call you at ${shown}` : "We will call you on the number you gave us";
}

/**
 * The number the call will come FROM (#1334), said the same way on the manage
 * page, in the invite and in the reminder email (L118).
 *
 * Call screening silences a number the lead has never seen, so a lead who books
 * and then misses the call has usually been screened rather than forgotten. Naming
 * the number, and saying why it is worth saving, is what lets the call through.
 *
 * Null when the number is not known, and every caller then says nothing about it:
 * a wrong number is worse than none (L75), and "a number we will tell you later"
 * is a promise nothing keeps. It is the CALLING number only, never the texting
 * line, which reaches nobody when called and changes often.
 */
export function callComesFrom(callingNumber: string | null): string | null {
  const shown = formatPhoneForDisplay(callingNumber);
  if (!shown) return null;
  return `${CALL_COMES_FROM_PREFIX}${shown}. Save it to your contacts so your phone lets it through.`;
}

/**
 * What a call on the placeholder advisor, Marcia, tells the customer about replies
 * (#4206, Dan 2026-10-26 and 27). Its invite and its 24 hour reminder go out from the
 * placeholder seat (scheduling@trypennie.com), whose inbox nobody reads, so neither
 * may invite a reply to itself. Nor do they name a number to text: the number Pennie
 * calls from reaches nobody by text, and the Sendblue line the texts come from lives
 * only in Regal and changes often. So a question goes back to the thread they already
 * have, the same instruction the seat's standing Gmail auto reply gives
 * (`PLACEHOLDER_SEAT_AUTO_REPLY`, `src/lib/monitor/placeholder-seat.ts`).
 *
 * It does NOT offer to change the call, and neither surface carries the manage link
 * (Dan, 2026-10-27: "I don't think we should encourage or say they can change the call.
 * If they text in and ask to change it we'll handle it then.").
 */
export const REPLY_TO_OUR_TEXTS = "If you have a question, reply to one of our texts and someone will answer you there.";

/** The placeholder's reply line, for the surface it is written on. */
export function placeholderReplyLine(surface: "email" | "invite"): string {
  return `Nobody reads replies to this ${surface}. ${REPLY_TO_OUR_TEXTS}`;
}

/** How the line starts, so an invite already carrying one can find it to replace. */
export const CALL_COMES_FROM_PREFIX = "The call will come from ";

/**
 * When the call is, spelled the way every other readback of a committed time on
 * this product spells it: with the year (#2205, L118). The manage page was the
 * one surface still leaving it off (#2579), which this closes.
 */
export function callWhen(longDay: string, time: string, durationMin: number): string {
  return `${longDay} at ${time} (${durationMin} minutes)`;
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
  "We could not find this booking. Open the reschedule or cancel link in your calendar " +
  "invitation again.";
export const MANAGE_PHONE_NOT_CHANGEABLE =
  "This call is over, so there is no number left to change. Book a new time whenever you are ready.";

/** The confirmation, naming the number that is now stored rather than the one typed. */
export function phoneSaved(phone: string): string {
  return `Saved. Your advisor will call you at ${formatPhoneForDisplay(phone) ?? phone}.`;
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
  /**
   * The heading over the day strip.
   *
   * It used to be a pair, swapping to "Choose a reason above, then pick a new
   * time" while the times were dead. Nothing is dead now: a tap selects and the
   * commit below asks for the reason, so the second sentence described a state
   * the panel no longer has and is gone rather than left reading as a considered
   * alternative (L29, #2605).
   */
  pickReady: "Pick a new time",
  /** On the slot being submitted, so the pressed time is the one that says it. */
  moving: "Moving…",
  /** The only way back out while the panel is open (#1336). */
  keepCurrent: "Keep my current time",
  noTimes: "All times are taken right now. Check back soon.",
  /** The move times could not be served for this booking at all (#2827). Held
   *  in a leaf module the shared picker can read without this file. */
  unavailable: RESCHEDULE_TIMES_UNAVAILABLE_SENTENCE,
  failed: "Could not reschedule. Please try again.",
  /**
   * What a move done ON this page says for itself once it lands (#1336, #2215).
   *
   * Reachable only from the action. It used to be gated on the booking's stored
   * status, which a reschedule sets permanently, so it was a moment rendered from
   * a persistent state: every later visit to the manage link was told the call had
   * just moved, and told that an invite the reader had clicked through to get here
   * was still on its way.
   */
  moved: "Your call is moved",
} as const;

/**
 * What the move picker says when it has nothing to offer (#2827).
 *
 * A call booked through an advisor's own link can only move to a time that
 * advisor can take, so "all times are taken" is untrue there: other people's
 * times may be wide open. The advisor is the subject, by name when the page has
 * one and never by pronoun, and the lead is told the one thing they can still do.
 * A routed call keeps the pooled sentence.
 */
export function rescheduleNoTimes(input: {
  from: "pool" | "advisor";
  advisorName: string | null;
}): string {
  if (input.from === "pool") return RESCHEDULE_COPY.noTimes;
  const who = input.advisorName ?? "Your advisor";
  return `${who} has no other open times in the next few days. Keep your current time, or check back later.`;
}

/**
 * The two facts the card cannot show for itself: a fresh invite is coming, and
 * the time they were holding is gone. The NEW time is the hero on the same
 * screen, so it is not said here a second time (L605).
 *
 * Falls back to a phrase rather than to a gap, like every other address line
 * here: "on its way to , and" reads as broken rather than as unknown.
 */
export function movedNote(attendeeEmail: string | null): string {
  const to = attendeeEmail ? ` to ${attendeeEmail}` : "";
  return `A new invite is on its way${to}, and the time you were holding has been released.`;
}

// --- a booking that is over ---------------------------------------------------
// Cancelled and already-happened are DIFFERENT screens: one is a decision the lead
// made and may want to reverse, the other is a call that took place. Offering
// "grab a new time" to somebody whose call just happened reads as though we did
// not notice it happened.
//
// Neither names "the same team" (#2615): a team is Slate's word for a routing
// pool, no lead has ever been shown one, and the pool is resolved fresh at
// booking time, so the phrase was a promise about machinery the reader cannot see.

export const DONE_COPY = {
  cancelledHeading: "This booking is cancelled",
  happenedHeading: "This call has happened",
  cancelledBody:
    "Changed your mind? You can grab a new time whenever you are ready.",
  happenedBody:
    "Need to talk again? You can book another time whenever you are ready.",
  bookAgain: "Book a new time",
} as const;

export function doneHeading(status: string): string {
  return status === "cancelled" ? DONE_COPY.cancelledHeading : DONE_COPY.happenedHeading;
}

export function doneBody(status: string): string {
  return status === "cancelled" ? DONE_COPY.cancelledBody : DONE_COPY.happenedBody;
}

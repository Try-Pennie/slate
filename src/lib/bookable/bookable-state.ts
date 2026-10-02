import type { Attributes } from "@/lib/db/types";
import { twilioUndoesBookable } from "@/lib/twilio/roster-plan";

/**
 * The bookable states a person is SHOWN in, and their words, in one place (#3030).
 *
 * Three, not two. "No" used to answer for two different people: an advisor who
 * genuinely is not bookable (setting up, calendar access, a decision nobody has
 * made) and one the hourly Twilio sync holds back because their worker carries
 * the Redistribute tag. Those send a manager to two different places, so they
 * read differently. Every surface that shows the state, the pill and the
 * roster's filter, enumerates THIS list, so the words cannot drift between them.
 */
export const BOOKABLE_STATES = ["yes", "no", "redistribute"] as const;
export type BookableState = (typeof BOOKABLE_STATES)[number];

/**
 * Which state a person is in. `heldByTwilio` is only consulted on the negative:
 * taking somebody OUT of the pool is never held back, so a bookable advisor whose
 * tag the sync has not acted on yet is simply bookable.
 */
export function bookableStateOf(bookable: boolean, heldByTwilio: boolean): BookableState {
  if (bookable) return "yes";
  return heldByTwilio ? "redistribute" : "no";
}

/**
 * Whether the hourly Twilio sync holds this person out of the pool, asked through
 * the same predicate the console's refusal and the server action use
 * (`twilioUndoesBookable`, #3028), so the pill, the filter and the refused toggle
 * cannot disagree about who is held.
 */
export function heldByTwilio(u: { bookable: boolean; attributes: Attributes | null }): boolean {
  return !u.bookable && twilioUndoesBookable(u.attributes);
}

/**
 * The words, per surface. Only the WORDS vary between surfaces; the variant and
 * the mark are one decision in `BookablePill`.
 *
 * "short" is a table cell under a column already headed Bookable, so the value is
 * Yes or No. "full" is where nothing else names the fact, so it carries the noun.
 * "self" is the advisor reading about themselves: "yet" because not bookable is a
 * state they are working towards, and "On Redistribute" because it says where they
 * are rather than naming a tag at them.
 *
 * Redistribute keeps the same word on the two manager surfaces, because it is
 * the name of the Twilio tag a manager removes to bring them back.
 */
export const BOOKABLE_STATE_TEXT: Record<"short" | "full" | "self", Record<BookableState, string>> = {
  short: { yes: "Yes", no: "No", redistribute: "Redistribute" },
  full: { yes: "Bookable", no: "Not bookable", redistribute: "Redistribute" },
  self: { yes: "Bookable", no: "Not bookable yet", redistribute: "On Redistribute" },
};

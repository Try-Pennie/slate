/**
 * Formatting the booker's phone field as the lead types (#1332).
 *
 * The phone number is how the advisor actually reaches the lead, so a typo costs
 * the call, and finding out at the submit step is the worst moment to be sent
 * back. Formatting and capping as they type puts the shape in front of them while
 * they can still see what they meant to write.
 *
 * **US only, and enforced as one rule everywhere (#1356).** Pennie can only CALL
 * a US number, so that is the rule the field, the prefill and the server all hold
 * to. It used to be enforced in two places that disagreed: the field capped at ten
 * digits while `validateAttendee` accepted 10 to 15, so a lead arriving with a
 * longer international number booked successfully, and a lead who cleared that
 * field could not type it back in. The product said two different things.
 *
 * `isUsPhone` is now the single judge. If Pennie ever calls outside the US, widen
 * THAT, and the field cap with it; do not reintroduce a validator that accepts
 * what the field cannot hold.
 */

/** The number of digits the field accepts. Stated once. */
export const PHONE_DIGITS = 10;

/**
 * The field's value after this keystroke: digits only, capped, punctuated.
 *
 * Runs over the whole current value rather than the last character, so it is
 * correct for a paste, a deletion and a caret in the middle alike, and so the
 * punctuation is never doubled up.
 */
export function formatPhoneAsTyped(value: string): string {
  let digits = value.replace(/\D/g, "");
  // A pasted country code is stripped only at ELEVEN digits. A real ten digit
  // number can begin with 1, and dropping that would produce a different, equally
  // plausible-looking number: keeping the first ten of "+1 215 555 0100" yields
  // "(121) 555-5010", which is silent and wrong, the worst combination for the one
  // field that has to be right. Only `1` is stripped: dropping "44" would turn a
  // British number into a wrong American one, so a non-US code is left to fail
  // validation visibly instead.
  if (digits.length === PHONE_DIGITS + 1 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  digits = digits.slice(0, PHONE_DIGITS);
  if (digits.length === 0) return "";
  // Punctuation is added only once the block it introduces has a digit in it, so a
  // lead backspacing through the field is never handed back a bracket or a dash
  // they just deleted.
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Is this a number Pennie can call? Ten digits, or eleven beginning with 1.
 *
 * THE rule (#1356). Every surface asks this one function, so the field, the
 * prefill and the server can never disagree about what US-shaped means, which is
 * exactly what they used to do.
 */
export function isUsPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  return (
    digits.length === PHONE_DIGITS ||
    (digits.length === PHONE_DIGITS + 1 && digits.startsWith("1"))
  );
}

/** Why a prefilled number was dropped, or null when it was kept (#1356, #1409). */
export type PhonePrefillDrop =
  /** A real number, and not one Pennie can call. They cannot retype it either,
   *  because the field caps at ten digits. */
  | "not-callable"
  /** Fewer than ten digits: an unfinished US number, which they CAN retype. */
  | "incomplete";

/**
 * A PREFILLED number, tidied if we can call it and DROPPED if we cannot (#1356,
 * #1409).
 *
 * Most real leads arrive with their phone already filled in from the landing page,
 * so that value is what the advisor ends up calling and it should read the same as
 * a typed one.
 *
 * The field never holds a number that could not be submitted as it stands, so
 * anything that is not a complete US number is dropped. But WHY it was dropped is
 * returned rather than left for the caller to infer from the value, and that is
 * the whole point of this shape: the two cases need different sentences and
 * inferring the reason is exactly how a lead whose number is merely unfinished
 * gets told about country codes (L11).
 *
 * The two also differ in consequence, which is worth knowing at the call site. A
 * dropped international number cannot be retyped, because the field caps at ten
 * digits; a dropped partial one can be finished in a keystroke.
 *
 * An ABSENT prefill is not a drop. An empty field is the ordinary case, and
 * explaining anything to somebody who was never shown a number would be noise.
 */
export function prefillPhone(value: string): { value: string; dropped: PhonePrefillDrop | null } {
  if (isUsPhone(value)) return { value: formatPhoneAsTyped(value), dropped: null };
  const digits = value.replace(/\D/g, "");
  if (digits.length === 0) return { value: "", dropped: null };
  return { value: "", dropped: digits.length < PHONE_DIGITS ? "incomplete" : "not-callable" };
}

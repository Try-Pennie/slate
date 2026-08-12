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
 *
 * **An extension is part of the number, not a longer number (#1423).** Judging on
 * digit count alone pushed a perfectly good US number out of range the moment a
 * lead gave the extension that actually reaches them, and the sentence they got
 * back was wrong as well as the verdict: they were told to enter a US number about
 * a US number, which is advice to do what they had already done (L111). The
 * extension is stripped BEFORE the country rule is applied, rather than the digit
 * rule being loosened, which would have let a genuinely foreign number back in.
 * `splitPhoneExtension` is the one place that stripping happens.
 *
 * It is stripped for JUDGING and kept for CALLING. The extension is how the
 * advisor gets past a switchboard, so it rides through the field, the prefill and
 * the stored string; the field shapes and caps it exactly as it does the number.
 */

/** The number of digits the field accepts. Stated once. */
export const PHONE_DIGITS = 10;

/**
 * The number of EXTENSION digits the field accepts, and therefore the number the
 * server accepts (#1423).
 *
 * The two have to be the same. A field that truncates where the validator accepts
 * more is a rule nothing states, blocking input the server would have taken (L99);
 * a validator that accepts more than the field can hold is the #1356 defect over
 * again, since the lead cannot type back what was refused.
 *
 * Six covers every real PBX extension; a value longer than this is not an
 * extension somebody dialled, and it is refused with its own sentence rather than
 * being mistaken for a foreign number.
 */
export const PHONE_EXT_DIGITS = 6;

/**
 * Everything from the extension marker to the end of the string: `x`, `ext`,
 * `extn`, `extension` or `#`, however it was punctuated, with the digits after it.
 *
 * `#` is accepted alongside the written forms because the field is `inputMode="tel"`
 * and a phone keypad offers `#` where it offers no letters at all, so it is the only
 * marker a lead on a phone can actually reach.
 *
 * Anchored to the END so it can never eat part of the number itself, and the digit
 * run is left UNBOUNDED here on purpose: capping in the pattern would make a
 * seventh typed digit fail to match at all, and the whole thing would silently
 * revert to being read as one long number mid-keystroke. The cap belongs where the
 * ten digit one already is, in the formatter.
 */
const EXTENSION_TAIL = /[\s,;.]*(?:ext(?:ension|n)?|x|#)[\s.:]*(\d*)\s*$/i;

/** A phone string split into the part that decides whether we can CALL it and the
 *  part that decides where the call LANDS. */
export type PhoneParts = {
  /** The number itself, punctuation and all, with any extension removed. */
  base: string;
  /** The extension's digits, or "" when there are none yet. */
  extension: string;
  /**
   * Whether an extension was STARTED, which is not the same as having digits in
   * it. A lead who has just typed the `x` has no digits yet, and a formatter that
   * cannot tell that apart from no extension at all eats the marker on the
   * keystroke that typed it, so the first digit can never be reached.
   */
  hasExtensionMarker: boolean;
};

/**
 * THE extension rule (#1423), asked by the field, the prefill and the server, so
 * none of them can disagree about where the number ends.
 */
export function splitPhoneExtension(value: string): PhoneParts {
  const match = EXTENSION_TAIL.exec(value);
  if (!match) return { base: value, extension: "", hasExtensionMarker: false };
  return {
    base: value.slice(0, match.index),
    extension: match[1] ?? "",
    hasExtensionMarker: true,
  };
}

/**
 * The field's value after this keystroke: digits only, capped, punctuated.
 *
 * Runs over the whole current value rather than the last character, so it is
 * correct for a paste, a deletion and a caret in the middle alike, and so the
 * punctuation is never doubled up.
 */
export function formatPhoneAsTyped(value: string): string {
  const parts = splitPhoneExtension(value);
  const number = formatPhoneNumberAsTyped(parts.base);
  // An extension with no number in front of it is not something to show: the same
  // reasoning that clears the brackets when the last digit is deleted.
  if (!number || !parts.hasExtensionMarker) return number;
  return `${number} x${parts.extension.slice(0, PHONE_EXT_DIGITS)}`;
}

/** The number itself, with any extension already removed by the caller. */
function formatPhoneNumberAsTyped(value: string): string {
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
  // The extension is removed BEFORE the count is taken (#1423). Loosening the count
  // instead would let a twelve digit foreign number back in.
  const digits = splitPhoneExtension(value).base.replace(/\D/g, "");
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
  const digits = splitPhoneExtension(value).base.replace(/\D/g, "");
  if (digits.length === 0) return { value: "", dropped: null };
  return { value: "", dropped: digits.length < PHONE_DIGITS ? "incomplete" : "not-callable" };
}

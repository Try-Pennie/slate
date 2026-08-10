/**
 * Formatting the booker's phone field as the lead types (#1332).
 *
 * The phone number is how the advisor actually reaches the lead, so a typo costs
 * the call, and finding out at the submit step is the worst moment to be sent
 * back. Formatting and capping as they type puts the shape in front of them while
 * they can still see what they meant to write.
 *
 * **US only, deliberately.** `validateAttendee` accepts 10 to 15 digits on
 * purpose, so unusual formatting cannot block a real lead; this display cap is
 * narrower than that. Pennie lends in the US and every lead arrives from a US
 * funnel, so a ten digit cap is right today, but it IS an assumption: a lead with
 * a longer international number could not type it into this field. Widen this,
 * not the validator, if that ever stops being true.
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
 * A PREFILLED number tidied to the same shape, but only when doing so cannot lose
 * anything (#1332).
 *
 * Most real leads arrive with their phone already filled in from the landing page,
 * so that value is what the advisor ends up calling and it should read the same as
 * a typed one. But `formatPhoneAsTyped` caps at ten digits, and running a genuinely
 * longer international number through it would silently truncate a number nobody
 * asked it to touch, which is worse than leaving it untidy: `validateAttendee`
 * accepts 10 to 15 digits precisely so unusual formatting cannot block a real lead.
 *
 * So this reformats ONLY what a US number can be: ten digits, or eleven beginning
 * with 1. Anything else is returned exactly as given, and reaches validation to
 * pass or fail on its own merits.
 */
export function formatPhoneIfUsShaped(value: string): string {
  const digits = value.replace(/\D/g, "");
  const isUsShaped =
    digits.length === PHONE_DIGITS ||
    (digits.length === PHONE_DIGITS + 1 && digits.startsWith("1"));
  return isUsShaped ? formatPhoneAsTyped(value) : value;
}

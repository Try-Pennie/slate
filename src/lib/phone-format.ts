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

/**
 * A PREFILLED number, tidied if we can call it and DROPPED if we cannot (#1356).
 *
 * Most real leads arrive with their phone already filled in from the landing page,
 * so that value is what the advisor ends up calling and it should read the same as
 * a typed one.
 *
 * Dan's decision, and the reason `discarded` is returned rather than just a
 * string: the field caps at ten digits, so a lead whose number is dropped cannot
 * type it back either. Dropping it silently would leave them staring at an empty
 * field with no idea why, and pressing confirm to be told "enter your phone
 * number", which is true and useless. The booker uses this flag to say what
 * happened.
 *
 * A number too SHORT is a different case and is KEPT: it is not a number we
 * refuse, it is an incomplete US one, and the lead can finish typing it. Vanishing
 * it under a message about country codes would be the wrong explanation for the
 * wrong problem (L11).
 */
export function prefillPhone(value: string): { value: string; discarded: boolean } {
  const digits = value.replace(/\D/g, "");
  if (isUsPhone(value)) return { value: formatPhoneAsTyped(value), discarded: false };
  // Nothing given, or a partial US number: leave it exactly as it is. Neither is
  // a refusal, so neither may be reported as one.
  if (digits.length < PHONE_DIGITS) return { value, discarded: false };
  return { value: "", discarded: true };
}

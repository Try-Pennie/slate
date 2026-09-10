/**
 * Naming a stored phone number by its last four digits (#2207).
 *
 * The existing call panel is reached by whoever holds the booking LINK, which is
 * a weaker credential than the manage token inside the calendar invite: that one
 * shows the number in full (#1341), and this one names it. A lead recognises
 * their own number from four digits; somebody who came by the link learns almost
 * nothing. Dan settled that on 2026-09-10.
 *
 * Pure, and its own module, so the panel and the server agree on one rule rather
 * than each slicing a string its own way (L41).
 */

/** The lowest number of digits that can be masked without showing all of them. */
const MIN_MASKABLE_DIGITS = 4;

/**
 * The last four digits of `phone`, or null when there is nothing that may be
 * named: no number at all, or one so short that naming four digits would be
 * handing over the whole value.
 *
 * Null rather than an empty string, because the caller has to tell "this booking
 * carries no number" from "a number ending in nothing", and the first is a
 * sentence that must not be written at all (L11).
 */
export function phoneLastFour(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < MIN_MASKABLE_DIGITS) return null;
  return digits.slice(-MIN_MASKABLE_DIGITS);
}

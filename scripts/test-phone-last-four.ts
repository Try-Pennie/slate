/**
 * The masked number on the existing call panel (#2207).
 *
 * A lead reaches that panel by a LINK, which is a weaker credential than the
 * manage token inside their own calendar invite, so the panel names the number by
 * its last four digits rather than showing it in full as the manage page does
 * (#1341). Dan settled that on 2026-09-10.
 *
 * The rule is pure, so it is tested here rather than through the component. What
 * it must never do is emit something a reader would take for a whole number, or
 * claim four digits it does not have.
 */
import { phoneLastFour } from "../src/lib/booking/phone-mask.ts";
import { eq, finish } from "./lib/harness.ts";

eq(phoneLastFour("(203) 561-5295"), "5295", "takes the last four of a formatted US number");
eq(phoneLastFour("2035615295"), "5295", "takes the last four of a bare number");
eq(phoneLastFour("+1 203-561-5295"), "5295", "ignores punctuation, not digits");

// Nothing to name is NOT an empty string: the panel has to tell "no number on this
// booking" from "a number ending in nothing", because the first is a sentence it
// must write differently and the second is one it must not write at all (L11).
eq(phoneLastFour(null), null, "null when the booking carries no number");
eq(phoneLastFour(""), null, "null when the number is empty");
eq(phoneLastFour("   "), null, "null when the number is blank");

// A value too short to mask is withheld rather than shown, because showing every
// digit of it is exactly the disclosure the masking exists to avoid: "ending 123"
// on a three digit value IS the whole value.
eq(phoneLastFour("123"), null, "null when there are fewer than four digits");
eq(phoneLastFour("1234"), "1234", "the four digit boundary is included");
// Letters are not digits, and a value whose digits are too few once they are
// stripped must not fall back to slicing the raw text.
eq(phoneLastFour("call-me"), null, "null when the text is long but its digits are not");

finish();

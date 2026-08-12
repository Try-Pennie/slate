/**
 * #1332: formatting the booker's phone field as the lead types.
 *
 * The phone number is how the advisor actually reaches the lead, so a typo here
 * costs the call, and the submit step is the worst moment to be sent back. The
 * field formats and caps as they type instead.
 *
 * The case that makes this worth testing rather than eyeballing is the pasted
 * country code. `+1 (215) 555-0100` is eleven digits, and a naive ten digit cap
 * keeps the FIRST ten, producing `(121) 555-5010`: a different number, still
 * eleven characters of plausible-looking formatting, with nothing to tell the
 * lead or the advisor that it is wrong. It is silent and it is wrong, which is the
 * worst combination for the one field that has to be right.
 *
 * The counter-case is just as important: a real ten digit number can legitimately
 * start with 1 (area codes do not, but the rule must not assume that), so
 * stripping a leading 1 may only ever happen at eleven digits.
 *
 * Run: node --experimental-strip-types scripts/test-phone-format.ts
 */
import {
  formatPhoneAsTyped,
  isUsPhone,
  prefillPhone,
  splitPhoneExtension,
  PHONE_DIGITS,
  PHONE_EXT_DIGITS,
} from "../src/lib/phone-format.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// ---------------------------------------------------- formatting as it grows

eq(formatPhoneAsTyped(""), "", "an empty field stays empty");
eq(formatPhoneAsTyped("2"), "(2", "the bracket opens on the first digit");
eq(formatPhoneAsTyped("215"), "(215", "no closing bracket until there is more to come");
eq(formatPhoneAsTyped("2155"), "(215) 5", "the bracket closes once the exchange starts");
eq(formatPhoneAsTyped("215555"), "(215) 555", "no dash until there is more to come");
eq(formatPhoneAsTyped("2155550"), "(215) 555-0", "the dash arrives with the last block");
eq(formatPhoneAsTyped("2155550100"), "(215) 555-0100", "a full number reads as one");

// Deleting has to be possible: a formatter that re-adds punctuation the lead has
// just backspaced over traps them mid-field.
eq(formatPhoneAsTyped("(215) 555-010"), "(215) 555-010", "a partly deleted number reformats cleanly");
eq(formatPhoneAsTyped("(215"), "(215", "backspacing to the area code leaves no stray bracket");
eq(formatPhoneAsTyped("("), "", "deleting the last digit clears the punctuation with it");

// ------------------------------------------------------------- the cap

eq(
  formatPhoneAsTyped("21555501001234"),
  "(215) 555-0100",
  "digits past the tenth are dropped rather than shown and then rejected at submit",
);
eq(PHONE_DIGITS, 10, "the cap is ten digits, stated once");

// ------------------------------------------------- the pasted country code

eq(
  formatPhoneAsTyped("+1 (215) 555-0100"),
  "(215) 555-0100",
  "a pasted +1 is stripped, not kept as the area code's first digit",
);
eq(
  formatPhoneAsTyped("12155550100"),
  "(215) 555-0100",
  "an eleven digit number starting with 1 loses the 1",
);
eq(
  formatPhoneAsTyped("1-215-555-0100"),
  "(215) 555-0100",
  "however the country code is punctuated",
);
// The silent corruption this exists to prevent.
eq(
  formatPhoneAsTyped("+12155550100"),
  "(215) 555-0100",
  "and never becomes (121) 555-5010, a different number that looks just as valid",
);

// The counter-case: at TEN digits a leading 1 is part of the number.
eq(
  formatPhoneAsTyped("1215555010"),
  "(121) 555-5010",
  "a ten digit number beginning with 1 keeps its 1",
);
eq(
  formatPhoneAsTyped("1"),
  "(1",
  "and a lone 1 is treated as a digit, not as a country code to strip",
);
eq(
  formatPhoneAsTyped("121555501"),
  "(121) 555-501",
  "nor is it stripped from any shorter number",
);

// A country code other than 1 is NOT stripped: dropping 44 would silently change
// a British number into a wrong American one, so it is left to fail validation
// visibly instead.
eq(
  formatPhoneAsTyped("+44 20 7946 0958"),
  "(442) 079-4609",
  "a non-US country code is left alone and reaches validation as typed",
);

// ---------------------------------------------------------- letters etc

eq(formatPhoneAsTyped("abc"), "", "letters contribute nothing");
eq(formatPhoneAsTyped("215-CALL"), "(215", "and are dropped from a mixed value");

// ------------------------------------------- a number that arrived prefilled
//
// Most real leads arrive with the phone already filled in from the landing page,
// so that value is what the advisor calls and it should read like a typed one.
//
// #1356, Dan's decision: Pennie can only CALL a US number, so a prefill that is
// not one is discarded rather than passed through. The two halves have to move
// together, which is what the issue was filed to settle: the field caps at ten
// digits, so a lead whose number is discarded cannot retype it either. Discarding
// without saying so would leave them staring at an empty field with no idea why,
// so `prefillPhone` reports WHETHER it dropped something and the booker says so.

eq(prefillPhone("2155550100").value, "(215) 555-0100", "a bare ten digit prefill is tidied to match a typed one");
eq(prefillPhone("+1 (215) 555-0100").value, "(215) 555-0100", "and so is one carrying a US country code");
eq(prefillPhone("(215) 555-0100").value, "(215) 555-0100", "one already in shape is unchanged");
eq(prefillPhone("2155550100").dropped, null, "a US number is kept");

eq(prefillPhone("").value, "", "an absent prefill stays absent");
eq(
  prefillPhone("").dropped,
  null,
  "an ABSENT prefill is not a dropped one: an empty field is the ordinary case, and " +
    "explaining anything to somebody who was never shown a number would be noise",
);

// The decision, both halves. Discarded AND reported, because one without the
// other is the defect the issue describes.
eq(prefillPhone("+44 20 7946 0958").value, "", "a non-US prefill is discarded, not passed through");
eq(prefillPhone("+44 20 7946 0958").dropped, "not-callable", "and says why, so the booker can explain the empty field");
eq(prefillPhone("+44 7911 123456").value, "", "a thirteen digit number the old validator accepted is discarded too");
eq(prefillPhone("+44 7911 123456").dropped, "not-callable", "and reports the reason");

// #1409, Dan's call: a partial number is dropped too, so the field never holds a
// number that cannot be submitted as it stands. But it is dropped for a DIFFERENT
// reason, and the reason is returned rather than left for the booker to infer from
// the value, because inferring it is how the wrong sentence gets shown to somebody
// whose number is simply unfinished (L11).
eq(prefillPhone("215555").value, "", "a partial US number is dropped as well");
eq(prefillPhone("215555").dropped, "incomplete", "and says it was incomplete, not that we cannot call it");
eq(
  prefillPhone("+44 20 7946 0958").dropped,
  "not-callable",
  "where a real number we cannot call is dropped for that reason instead",
);
eq(prefillPhone("2155550100").dropped, null, "a US number is not dropped at all");
eq(prefillPhone("").dropped, null, "and neither is an absent one: an empty field is the ordinary case");

// The two reasons must stay distinguishable, or the booker can only ever show one
// sentence and it will be wrong half the time.
assert(
  prefillPhone("215555").dropped !== prefillPhone("+44 20 7946 0958").dropped,
  "the two drops are told apart",
);

// isUsPhone is the ONE rule, so the field, the prefill and the server cannot
// disagree about what US-shaped means.
eq(isUsPhone("2155550100"), true, "ten digits is US");
eq(isUsPhone("12155550100"), true, "eleven beginning with 1 is US");
eq(isUsPhone("+1 (215) 555-0100"), true, "punctuation and a plus do not change that");
eq(isUsPhone("442079460958"), false, "twelve digits is not");
eq(isUsPhone("22155550100"), false, "eleven NOT beginning with 1 is not");
eq(isUsPhone("215555"), false, "and neither is an incomplete one");
eq(isUsPhone(""), false, "nor an empty string");

// --------------------------------------------------------- the extension (#1423)
//
// An extension is a normal thing for a lead to have given, and #1356 judged on
// digit COUNT, so any trailing extension digits pushed a perfectly good US number
// out of range. The verdict was wrong AND the sentence was wrong: the lead was
// told "we can only call a US number" about a US number, which asks them to do
// something they have already done.
//
// The fix strips the extension before judging rather than loosening the digit
// rule, which would have let a genuinely foreign number back in. It is stripped in
// ONE place, `splitPhoneExtension`, which the field, the prefill and the server all
// ask, so they cannot disagree again.

eq(splitPhoneExtension("2155550100").base, "2155550100", "a number with no extension is all base");
eq(splitPhoneExtension("2155550100").extension, "", "and carries no extension digits");
eq(
  splitPhoneExtension("2155550100").hasExtensionMarker,
  false,
  "and is not treated as having started one",
);

for (const written of [
  "215-555-0100 x123",
  "215-555-0100x123",
  "215-555-0100 X123",
  "(215) 555-0100 ext 123",
  "(215) 555-0100 ext. 123",
  "(215) 555-0100 extension 123",
  "(215) 555-0100 extn 123",
  "(215) 555-0100, x123",
  "(215) 555-0100 #123",
]) {
  const parts = splitPhoneExtension(written);
  eq(parts.extension, "123", `the extension is read off ${JSON.stringify(written)}`);
  eq(
    parts.base.replace(/\D/g, ""),
    "2155550100",
    `and the base keeps every digit of the number itself in ${JSON.stringify(written)}`,
  );
  eq(isUsPhone(written), true, `so ${JSON.stringify(written)} is judged on the number, not the extension`);
}

// The point of stripping rather than loosening: a foreign number does not get in
// through the extension door.
eq(isUsPhone("+44 20 7946 0958 x12"), false, "an extension does not make a foreign number callable");
eq(isUsPhone("215555 x12"), false, "nor does it complete an unfinished one");

// A trailing marker with no digits yet is somebody part way through typing one, not
// an extension and not garbage. It has to survive the keystroke, or the lead can
// never type the first digit of it.
eq(splitPhoneExtension("(215) 555-0100 x").hasExtensionMarker, true, "a bare marker is a started extension");
eq(splitPhoneExtension("(215) 555-0100 x").extension, "", "with no digits in it yet");
eq(
  formatPhoneAsTyped("(215) 555-0100x"),
  "(215) 555-0100 x",
  "so the x survives the keystroke that typed it",
);
eq(
  formatPhoneAsTyped("(215) 555-0100 x1"),
  "(215) 555-0100 x1",
  "and the first extension digit lands in it",
);
eq(
  formatPhoneAsTyped("215-555-0100 ext. 123"),
  "(215) 555-0100 x123",
  "however it was written, it is shown one way",
);
eq(
  formatPhoneAsTyped("(215) 555-0100 x"),
  "(215) 555-0100 x",
  "and deleting the last extension digit leaves the marker, not a re-added one",
);
eq(
  formatPhoneAsTyped("(215) 555-0100 "),
  "(215) 555-0100",
  "deleting the marker itself clears it, the way the brackets already clear",
);
eq(formatPhoneAsTyped("x"), "", "a marker with no number in front of it is nothing to show");

// The field caps the extension the same way it caps the number, and the server
// refuses the same length the field refuses to hold, so neither is stricter than
// the other (L99).
eq(PHONE_EXT_DIGITS, 6, "the extension cap is stated once");
eq(
  formatPhoneAsTyped("2155550100 x1234567890"),
  `(215) 555-0100 x${"123456"}`,
  "extension digits past the cap are dropped as they are typed",
);

// The base cap still applies underneath: eleven digits beginning with 1 lose the 1,
// and the extension does not disturb that.
eq(
  formatPhoneAsTyped("+1 (215) 555-0100 x99"),
  "(215) 555-0100 x99",
  "a pasted +1 is still stripped when an extension rides along",
);

// A prefilled number with an extension is KEPT, extension and all: it is how the
// advisor actually reaches the person, and dropping it silently would lose the
// half of the number that gets them past a switchboard.
eq(
  prefillPhone("215-555-0100 ext 4021").value,
  "(215) 555-0100 x4021",
  "a prefilled extension is kept and tidied, not discarded",
);
eq(prefillPhone("215-555-0100 ext 4021").dropped, null, "and nothing is reported as dropped");


finish();

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
  PHONE_DIGITS,
} from "../src/lib/phone-format.ts";
import { eq, finish } from "./lib/harness.ts";

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
eq(prefillPhone("2155550100").discarded, false, "a US number is not discarded");

eq(prefillPhone("").value, "", "an absent prefill stays absent");
eq(
  prefillPhone("").discarded,
  false,
  "and an ABSENT prefill is not a discarded one: an empty field is the ordinary case, and " +
    "explaining a rule to somebody who was never shown a number would be noise",
);

// The decision, both halves. Discarded AND reported, because one without the
// other is the defect the issue describes.
eq(prefillPhone("+44 20 7946 0958").value, "", "a non-US prefill is discarded, not passed through");
eq(prefillPhone("+44 20 7946 0958").discarded, true, "and says so, so the booker can explain why the field is empty");
eq(prefillPhone("+44 7911 123456").value, "", "a thirteen digit number the old validator accepted is discarded too");
eq(prefillPhone("+44 7911 123456").discarded, true, "and reports it");

// A number too SHORT is not the same case. It is not an international number we
// refuse, it is an incomplete US one, so it stays in the field for the lead to
// finish rather than vanishing under a message about country codes (L11).
eq(prefillPhone("215555").value, "215555", "a partial US number is kept, not discarded");
eq(prefillPhone("215555").discarded, false, "and is not reported as refused");

// isUsPhone is the ONE rule, so the field, the prefill and the server cannot
// disagree about what US-shaped means.
eq(isUsPhone("2155550100"), true, "ten digits is US");
eq(isUsPhone("12155550100"), true, "eleven beginning with 1 is US");
eq(isUsPhone("+1 (215) 555-0100"), true, "punctuation and a plus do not change that");
eq(isUsPhone("442079460958"), false, "twelve digits is not");
eq(isUsPhone("22155550100"), false, "eleven NOT beginning with 1 is not");
eq(isUsPhone("215555"), false, "and neither is an incomplete one");
eq(isUsPhone(""), false, "nor an empty string");

finish();

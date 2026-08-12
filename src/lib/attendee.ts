/**
 * Attendee contact validation, shared by the Booker form (client) and the
 * bookings API (server) so the rules can never drift. Pure; exercised by
 * scripts/test-attendee.ts.
 *
 * Phone is US only (#1356), asked through the SAME `isUsPhone` the booker's field
 * and its prefill use. It used to be a light 10 to 15 digit shape check while the
 * field capped at ten, so a longer international number was refused by the field
 * and accepted here: the product said two different things about one number, and a
 * lead who cleared that field could not type it back in. Pennie can only CALL a US
 * number, so that is the rule, held in one place.
 */
import { INPUT_LIMITS } from "./booking/input-limits.ts";
import { isUsPhone, PHONE_DIGITS } from "./phone-format.ts";

export type AttendeeInput = { name?: string; email?: string; phone?: string };
export type AttendeeErrors = Partial<Record<"name" | "email" | "phone", string>>;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Contact length cap (#1034): reject a multi-MB blob before it reaches Postgres /
// gcal event bodies / webhook payloads. Checked before the shape regex so a huge
// string is rejected on length rather than scanned.
const MAX = INPUT_LIMITS.contact;

export function validateAttendee(attendee: AttendeeInput): AttendeeErrors {
  const errors: AttendeeErrors = {};

  const name = attendee.name?.trim() ?? "";
  if (!name) {
    errors.name = "Enter your name";
  } else if (name.length > MAX) {
    errors.name = "Name is too long";
  }

  const email = attendee.email?.trim() ?? "";
  if (!email) {
    errors.email = "Enter your email";
  } else if (email.length > MAX || !EMAIL_SHAPE.test(email)) {
    errors.email = "Enter a valid email address";
  }

  const phone = attendee.phone?.trim() ?? "";
  const digits = phone.replace(/\D/g, "");
  if (!phone) {
    errors.phone = "Enter your phone number";
  } else if (phone.length > MAX || digits.length < PHONE_DIGITS) {
    // Incomplete, not foreign. Telling this lead about country codes would send
    // them looking for a problem they do not have (L11).
    errors.phone = "Enter a valid phone number";
  } else if (!isUsPhone(phone)) {
    // Long enough to be a real number, and not one we can call. Say which, because
    // "invalid" would read as a typo and they would try the same number again.
    errors.phone = "We can only call a US number. Please enter one.";
  }

  return errors;
}

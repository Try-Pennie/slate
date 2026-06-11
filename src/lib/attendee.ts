/**
 * Attendee contact validation, shared by the Booker form (client) and the
 * bookings API (server) so the rules can never drift. Pure; exercised by
 * scripts/test-attendee.ts.
 *
 * Phone stays a light shape check (10 to 15 digits): toE164 normalizes for
 * webhooks and deliberately never drops a number, so rejecting aggressively
 * here would only block real leads with unusual formatting.
 */
export type AttendeeInput = { name?: string; email?: string; phone?: string };
export type AttendeeErrors = Partial<Record<"name" | "email" | "phone", string>>;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateAttendee(attendee: AttendeeInput): AttendeeErrors {
  const errors: AttendeeErrors = {};

  if (!attendee.name?.trim()) {
    errors.name = "Enter your name";
  }

  const email = attendee.email?.trim() ?? "";
  if (!email) {
    errors.email = "Enter your email";
  } else if (!EMAIL_SHAPE.test(email)) {
    errors.email = "Enter a valid email address";
  }

  const phone = attendee.phone?.trim() ?? "";
  const digits = phone.replace(/\D/g, "");
  if (!phone) {
    errors.phone = "Enter your phone number";
  } else if (digits.length < 10 || digits.length > 15) {
    errors.phone = "Enter a valid phone number";
  }

  return errors;
}

/**
 * Attendee contact validation, shared by the Booker form (client) and the
 * bookings API (server) so the rules can never drift. Pure; exercised by
 * scripts/test-attendee.ts.
 *
 * Phone is US only (#1356) and carries no extension (#1425), both asked through
 * the SAME `phone-format.ts` helpers the booker's field and its prefill use. It used to be a light 10 to 15 digit shape check while the
 * field capped at ten, so a longer international number was refused by the field
 * and accepted here: the product said two different things about one number, and a
 * lead who cleared that field could not type it back in. Pennie can only CALL a US
 * number, so that is the rule, held in one place.
 */
import { INPUT_LIMITS } from "./booking/input-limits.ts";
import { US_ONLY_PHONE_NOTICE } from "./booking/booker-copy.ts";
import { isUsPhone, PHONE_DIGITS, splitPhoneExtension } from "./phone-format.ts";

export type AttendeeInput = { name?: string; email?: string; phone?: string };
export type AttendeeErrors = Partial<Record<"name" | "email" | "phone", string>>;

/**
 * The name as the BOOKER asks for it: two fields, the way cal.com asks (#2362).
 *
 * The payload, the stored row and `validateAttendee` all carry one `name` and go
 * on doing so. These two exist so the FIRST name is something a lead answered
 * rather than something Slate worked out by splitting whatever they typed into a
 * single box. That guess was right for "Mary Smith" and wrong for "Smith, Mary",
 * and it is not internal: it reaches Regal and greets the lead in the first
 * message Pennie ever sends them.
 */
export type NameFields = { firstName?: string; lastName?: string };
export type NameFieldErrors = Partial<Record<"firstName" | "lastName", string>>;

/** What the two fields make: the one name every layer below the form carries. */
export function joinName(fields: NameFields): string {
  return [fields.firstName?.trim(), fields.lastName?.trim()]
    .filter((part): part is string => !!part)
    .join(" ");
}

/**
 * The first name a booking STORES beside its joined name (#2549), or null.
 *
 * Only a value the lead answered, and only when the joined name begins with it
 * as a whole word. That keeps the two columns one fact: the last name is then
 * exactly what follows the first, rather than a second guess, and a first name
 * that disagrees with the name it travels with is not stored at all. Null means
 * "nobody answered", and every reader falls back to the old split for it; it is
 * never filled with that split, which would present a guess as an answer (L192).
 */
export function storedFirstName(
  name: string | null | undefined,
  firstName: string | null | undefined,
): string | null {
  const full = (name ?? "").trim();
  const first = (firstName ?? "").trim();
  if (!full || !first) return null;
  if (full === first) return first;
  return full.startsWith(first) && /\s/.test(full.charAt(first.length)) ? first : null;
}

/**
 * The last name that goes with a stored first name: whatever the joined name
 * holds after it, or undefined when there is nothing after it or the two do not
 * agree. Never a split of the whole name.
 */
export function lastNameAfter(name: string | null | undefined, firstName: string): string | undefined {
  const full = (name ?? "").trim();
  if (storedFirstName(full, firstName) === null) return undefined;
  return full.slice(firstName.trim().length).trim() || undefined;
}

/**
 * A prefilled full name, shown as the two fields.
 *
 * This is the one split left, and it happens IN FRONT OF THE LEAD: a landing page
 * hands over one string, the fields show what Slate made of it, and the person can
 * correct it before they commit. An inference somebody can see and change is not
 * an inference presented as a recorded fact (L192).
 *
 * Everything after the first word is the last name, so joining the two back
 * together returns exactly what arrived.
 */
export function splitName(full: string | null | undefined): Required<NameFields> {
  const parts = (full ?? "").trim().split(/\s+/).filter((p) => p.length > 0);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

/**
 * A returning lead's two name fields (#2835): the first name they ANSWERED last
 * time, with only what follows it as the last name, whenever that answer agrees
 * with the joined name the form is showing. Otherwise the visible split above.
 *
 * `guessed` says the fields hold that split of a name with more than one word,
 * which is Slate's inference rather than anything the lead answered. A caller
 * that stores the first name must not send back an untouched guess as one: that
 * would overwrite an answered "Mary Jo" with "Mary", or record a guess as an
 * answer (L192). A single word needs no split, so it is never a guess.
 */
export function prefillNameFields(
  name: string | null | undefined,
  firstName: string | null | undefined,
): Required<NameFields> & { guessed: boolean } {
  const full = (name ?? "").trim().replace(/\s+/g, " ");
  const first = storedFirstName(full, (firstName ?? "").trim().replace(/\s+/g, " "));
  if (first !== null) return { firstName: first, lastName: lastNameAfter(full, first) ?? "", guessed: false };
  const split = splitName(full);
  return { ...split, guessed: split.lastName !== "" };
}

/**
 * Which FIELD is wrong, which the joined name cannot say.
 *
 * Only the first name is required, matching cal.com and leaving somebody with one
 * name able to book. It is never stricter than `validateAttendee`, which judges
 * the joined value: a non-empty first name always joins to a non-empty name, so
 * the form refuses nothing the server would have taken (L99). The length cap is
 * the server's, on the joined value, because that is what gets stored.
 */
export function nameFieldErrors(fields: NameFields): NameFieldErrors {
  const errors: NameFieldErrors = {};
  if (!fields.firstName?.trim()) errors.firstName = "Enter your first name";
  else if (joinName(fields).length > MAX) errors.firstName = "Name is too long";
  return errors;
}

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
  // The extension is separated before any of these judgements (#1423): counted in,
  // it pushes a perfectly callable US number out of range, and the lead is then
  // told to enter a US number about a US number.
  const { base, extension } = splitPhoneExtension(phone);
  const digits = base.replace(/\D/g, "");
  if (!phone) {
    errors.phone = "Enter your phone number";
  } else if (phone.length > MAX || digits.length < PHONE_DIGITS) {
    // Incomplete, not foreign. Telling this lead about country codes would send
    // them looking for a problem they do not have (L11).
    errors.phone = "Enter a valid phone number";
  } else if (!isUsPhone(phone) || extension.length > 0) {
    // Long enough to be a real number, and not one we will take. Say which, because
    // "invalid" would read as a typo and they would try the same number again.
    //
    // ONE sentence for both, Dan's call, 2026-08-12. An extension is refused rather
    // than stripped (#1425), so an integration posting a lead's number is told
    // instead of a booking quietly carrying a number nobody asked for, and it is
    // told with the same sentence a number we cannot call gets. The INCOMPLETE case
    // above deliberately keeps its own: that lead's number is short, not refused,
    // and this sentence would send them after a problem they do not have (L11).
    errors.phone = US_ONLY_PHONE_NOTICE;
  }

  return errors;
}

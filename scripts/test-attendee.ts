// Sanity test for the shared attendee contact validation (#37).
// Run: node --experimental-strip-types scripts/test-attendee.ts
import {
  validateAttendee,
  joinName,
  splitName,
  nameFieldErrors,
  storedFirstName,
  prefillNameFields,
  INVALID_EMAIL,
} from "../src/lib/attendee.ts";
import { US_ONLY_PHONE_NOTICE } from "../src/lib/booking/booker-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const valid = {
  name: "Dana Lead",
  email: "dana@example.com",
  phone: "(203) 561-5295",
};

assert(
  Object.keys(validateAttendee(valid)).length === 0,
  "well-formed attendee passes",
);

// name
assert(!!validateAttendee({ ...valid, name: "" }).name, "empty name rejected");
assert(!!validateAttendee({ ...valid, name: "   " }).name, "whitespace name rejected");
assert(!!validateAttendee({ name: undefined, email: valid.email, phone: valid.phone }).name, "missing name rejected");

// email
assert(!!validateAttendee({ ...valid, email: "" }).email, "empty email rejected");
assert(!!validateAttendee({ ...valid, email: "dana" }).email, "no-domain email rejected");
assert(!!validateAttendee({ ...valid, email: "dana@example" }).email, "no-TLD email rejected");
assert(!!validateAttendee({ ...valid, email: "dana @example.com" }).email, "email with spaces rejected");
assert(
  Object.keys(validateAttendee({ ...valid, email: "  dana@example.com  " })).length === 0,
  "email is trimmed before checking",
);

// #3359: the rule Google applies. A lead at 2:32 AM ET on 2026-10-06 typed an
// address whose local part ended in a dot; Slate took it, Google's events.insert
// refused it ("400 invalid: Invalid attendee email."), and the lead was answered
// with a 500 five times. Each shape below is one Google refuses, so the form must
// say so at the field rather than let the confirm fail at the calendar.
for (const [email, why] of [
  ["dana.@example.com", "a local part ending in a dot (the production address's shape)"],
  [".dana@example.com", "a local part starting with a dot"],
  ["da..na@example.com", "consecutive dots in the local part"],
  ["dana@example..com", "an empty label in the domain"],
  ["dana@.example.com", "a domain starting with a dot"],
] as const) {
  eq(
    validateAttendee({ ...valid, email }).email,
    INVALID_EMAIL,
    `${why} is refused with the lead's own sentence`,
  );
}
// And the rule is no stricter than it has to be: a dot inside the local part, a
// plus tag, a subdomain and a long TLD all reach Google and are booked today.
for (const email of [
  "dana.lead@example.com",
  "d.a.n.a@example.com",
  "dana+slate@example.com",
  "dana@mail.example.co.uk",
  "dana_lead-1@example.travel",
]) {
  eq(validateAttendee({ ...valid, email }).email, undefined, `${email} is still accepted`);
}

// phone
assert(!!validateAttendee({ ...valid, phone: "" }).phone, "empty phone rejected");
assert(!!validateAttendee({ ...valid, phone: "12345" }).phone, "too-short phone rejected");
assert(!!validateAttendee({ ...valid, phone: "1".repeat(16) }).phone, "too-long phone rejected");
assert(
  Object.keys(validateAttendee({ ...valid, phone: "+1 203 561 5295" })).length === 0,
  "E.164-ish phone with punctuation passes",
);
assert(
  Object.keys(validateAttendee({ ...valid, phone: "2035615295" })).length === 0,
  "bare 10-digit US phone passes",
);

// length caps (#1034): name/email/phone <= 200 chars so a caller can't store a
// multi-MB blob that flows into Postgres / gcal event bodies / webhook payloads.
assert(
  Object.keys(validateAttendee({ ...valid, name: "a".repeat(200) })).length === 0,
  "200-char name accepted (at the cap)",
);
assert(!!validateAttendee({ ...valid, name: "a".repeat(201) }).name, "over-200-char name rejected");
assert(
  !!validateAttendee({ ...valid, email: "a".repeat(200) + "@example.com" }).email,
  "over-200-char email rejected (even with a valid shape)",
);
// A phone with <=15 digits but a huge raw string (padding) passes the digit
// check yet must be rejected by the length cap.
assert(
  !!validateAttendee({ ...valid, phone: "1234567890" + "-".repeat(200) }).phone,
  "over-200-char phone rejected (10 digits but huge raw string)",
);

// multiple errors at once
const all = validateAttendee({ name: "", email: "nope", phone: "1" });
assert(
  !!all.name && !!all.email && !!all.phone,
  "reports every invalid field, not just the first",
);

/** The phone error for a candidate number, with the other fields valid. */
function phoneError(phone: string): string | undefined {
  return validateAttendee({ name: "Dana", email: "d@e.com", phone }).phone;
}

// --- US only, in ONE place (#1356) -------------------------------------------
// Dan's decision: Pennie can only CALL a US number. The field already capped at
// ten digits while this accepted 10 to 15, so a longer international number was
// refused by the field and accepted by the server, and the product said two
// different things about the same number. The validator now asks the same
// question the field does.
{
  eq(phoneError("(215) 555-0100"), undefined, "a formatted US number is accepted");
  eq(phoneError("2155550100"), undefined, "a bare ten digit number is accepted");
  eq(phoneError("+1 215 555 0100"), undefined, "and one carrying the US country code");

  // The case this issue exists for. It used to book successfully.
  const intl = phoneError("+44 20 7946 0958");
  assert(intl !== undefined, "an international number is refused");
  assert(
    /US/.test(intl ?? ""),
    `and the message says WHY, naming the rule rather than calling it invalid (got: ${intl})`,
  );

  // Distinct causes, distinct messages (L11). Somebody who typed eight digits has
  // an incomplete number, not a foreign one, and telling them about US numbers
  // would send them looking for a problem they do not have.
  const short = phoneError("21555");
  assert(short !== undefined, "a number too short is still refused");
  assert(
    !/US/.test(short ?? ""),
    `and is NOT told about country codes: it is an incomplete number (got: ${short})`,
  );
  assert(short !== intl, "the two causes do not share a message");

  eq(phoneError(""), "Enter your phone number", "an empty field keeps its own message");
}

// ---------------------------------------------- the extension (#1423, #1425)
{
  // Dan's decision, 2026-08-12: Pennie asks for a number with no extension, and the
  // API refuses one rather than stripping it, so an upstream integration is told to
  // send a clean number instead of a booking silently carrying a number nobody
  // asked for.
  for (const written of [
    "215-555-0100 x123",
    "(215) 555-0100 ext. 4021",
    "+1 215 555 0100 extension 7",
    "2155550100#12",
  ]) {
    const err = phoneError(written);
    assert(err !== undefined, `a number carrying an extension is refused: ${written}`);
    // Dan's call, 2026-08-12: ONE refusal sentence for a number we will not take,
    // rather than a separate one naming the extension. Pinned against the constant,
    // not a substring, so the two cannot drift into looking alike while differing.
    eq(err, US_ONLY_PHONE_NOTICE, `and it is the one refusal sentence: ${written}`);
  }

  // The extension is SEPARATED before the number is judged, so the reason a lead is
  // given is the one that is true of them. Counting those digits is what made a
  // real US number report as foreign.
  const intlExt = phoneError("+44 20 7946 0958 x12");
  assert(intlExt !== undefined, "a foreign number with an extension is still refused");
  eq(intlExt, US_ONLY_PHONE_NOTICE, "with that same sentence");

  const shortExt = phoneError("21555 x12");
  assert(shortExt !== undefined, "an unfinished number with an extension is refused too");
  assert(
    !/US/.test(shortExt ?? ""),
    `and that lead is told it is incomplete, not foreign (got: ${shortExt})`,
  );

  // The extension and the foreign number now share one sentence, deliberately.
  // The UNFINISHED one still does not: that lead's number is short, not refused, and
  // sending them to look at country codes would be sending them after a problem they
  // do not have (L11).
  eq(phoneError("2155550100 x1"), intlExt, "an extension is refused with the same sentence");
  assert(shortExt !== intlExt, "and an unfinished number keeps its own");

  eq(phoneError("2155550100"), undefined, "a clean US number is still accepted");
}

// --- the first name is ASKED for, not derived (#2362) --------------------------
// cal.com asks in two fields, First Name required and Last Name optional. Slate
// asked in one and split on the first space, which is right for "Mary Smith" and
// wrong for everything else somebody types into a single name box: "Smith, Mary"
// gave a first name of "Smith,". That name is not internal, it is what the
// confirmation SMS greets the lead with, so the guess was visible in the first
// message they ever got from Pennie.
{
  // What a lead typed into two fields becomes the one `name` the payload has
  // always carried, so nothing downstream changes shape.
  eq(joinName({ firstName: "Mary", lastName: "Smith" }), "Mary Smith", "two fields make one name");
  eq(joinName({ firstName: "Mary" }), "Mary", "a last name is optional, as it is on cal.com");
  eq(joinName({ firstName: " Mary ", lastName: " Smith " }), "Mary Smith", "and both are trimmed");
  eq(joinName({}), "", "nothing typed joins to nothing, which validateAttendee refuses");

  // The PREFILL is the one place a split still happens, and it happens in front of
  // the lead: a landing page hands over one string, the two fields show the guess,
  // and the person can correct it before they commit. An inference somebody can see
  // and change is not an inference presented as a recorded fact (L192).
  eq(splitName("Mary Smith").firstName, "Mary", "a prefilled full name fills the first field");
  eq(splitName("Mary Smith").lastName, "Smith", "and the second");
  eq(splitName("Mary Jo Smith").lastName, "Jo Smith", "everything after the first word is the last name");
  eq(splitName("Prince").firstName, "Prince", "one word fills the first field");
  eq(splitName("Prince").lastName, "", "and leaves the optional one empty");
  eq(splitName("  Mary   Smith  ").firstName, "Mary", "surrounding and repeated spaces do not survive");
  eq(splitName("").firstName, "", "nothing in, nothing out");
  eq(splitName(null).firstName, "", "and a missing prefill is not a name");

  // The round trip a real lead makes: arrive with a prefill, change nothing,
  // submit. What is stored must be what arrived.
  for (const full of ["Mary Smith", "Prince", "Mary Jo Smith"]) {
    eq(joinName(splitName(full)), full, `a prefilled "${full}" survives being shown in two fields`);
  }

  // The field-level rule. The FIRST name is the required one, so somebody with one
  // name is never refused, and nothing is stricter than the joined name the server
  // judges: a non-empty first name always joins to a non-empty name (L99).
  eq(nameFieldErrors({ firstName: "Mary" }).firstName, undefined, "a first name alone is accepted");
  assert(!!nameFieldErrors({ firstName: "" }).firstName, "an empty first name is refused");
  assert(!!nameFieldErrors({ firstName: "   " }).firstName, "and so is a blank one");
  eq(
    nameFieldErrors({ firstName: "Mary", lastName: "" }).lastName,
    undefined,
    "an empty last name is not an error, because it is not required",
  );
  // The two judgements agree about every name the form can produce, which is what
  // keeps the client from refusing something the server would take.
  for (const fields of [{ firstName: "Mary" }, { firstName: "Mary", lastName: "Smith" }]) {
    eq(
      Object.keys(nameFieldErrors(fields)).length,
      Object.keys(validateAttendee({ ...valid, name: joinName(fields) })).length,
      "the field rule and the joined-name rule agree",
    );
  }
}


// #2549: what the booking stores as the ANSWERED first name. It must be the start
// of the joined name it travels with, so the last name can be read off the
// remainder exactly rather than guessed.
eq(storedFirstName("Mary Jo Smith", "Mary Jo"), "Mary Jo", "a first name the name starts with is stored");
eq(storedFirstName("Mary Jo Smith", "  Mary Jo "), "Mary Jo", "trimmed, like the name it joins");
eq(storedFirstName("Cher", "Cher"), "Cher", "a lone first name is the whole name");
eq(storedFirstName("Mary Jo Smith", undefined), null, "nothing answered stores nothing, never a split");
eq(storedFirstName("Mary Jo Smith", "   "), null, "a blank answer stores nothing");
eq(storedFirstName("Smith Mary", "Mary"), null, "a first name the joined name does not start with is refused, not stored beside it");
eq(storedFirstName("Maryanne Smith", "Mary"), null, "a prefix that ends mid word is not the first name");
eq(storedFirstName(undefined, "Mary"), null, "no name, no first name");

// #2835: a returning lead's two name fields are seeded from the first name they
// ANSWERED last time whenever it agrees with the joined name, and fall back to
// the visible split only when it does not.
{
  const mj = prefillNameFields("Mary Jo Smith", "Mary Jo");
  eq(mj.firstName, "Mary Jo", "the answered first name fills the first field whole");
  eq(mj.lastName, "Smith", "and only what follows it is the last name");
  eq(mj.guessed, false, "and that is an answer, not a guess");
  eq(joinName(mj), "Mary Jo Smith", "joining them back returns the stored name exactly");

  // A stored first name the joined name does not start with is not one fact with
  // it, so it is dropped rather than shown beside a name it contradicts.
  const disagree = prefillNameFields("Mary Jo Smith", "Robin");
  eq(disagree.firstName, "Mary", "a disagreeing first name falls back to the split");
  eq(disagree.lastName, "Jo Smith", "all of it");
  eq(disagree.guessed, true, "and the split is marked as the guess it is");

  const midWord = prefillNameFields("Maryanne Smith", "Mary");
  eq(midWord.firstName, "Maryanne", "a first name ending mid word does not agree either");

  const none = prefillNameFields("Mary Jo Smith", null);
  eq(none.firstName, "Mary", "no answer on record keeps the old split");
  eq(none.guessed, true, "which is a guess");

  // One word needs no split, so there is nothing guessed about it.
  eq(prefillNameFields("Cher", null).guessed, false, "a lone name is not a guess");
  eq(prefillNameFields("Cher", null).firstName, "Cher", "and fills the first field");
  eq(prefillNameFields("", "Mary").firstName, "", "no name, nothing seeded, whatever the first name says");
  eq(prefillNameFields("", "Mary").guessed, false, "and nothing guessed");
  eq(prefillNameFields("  Mary Jo   Smith ", " Mary Jo ").lastName, "Smith", "padding does not survive");
}

finish();

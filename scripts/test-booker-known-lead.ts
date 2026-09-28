/**
 * What a landing link that IDENTIFIES somebody puts in the details form (#2208).
 *
 * `/booking/{salesforceId}` and `/book?external_id=` both resolve the lead well
 * enough to find the call they already have (#2166). Until this, that knowledge
 * was used for exactly one thing, and a lead with no call was handed an empty
 * Name, Email and Phone form to retype what Slate was already holding.
 *
 * The decision #2208 asked for, settled before this was built: FILL IT. The
 * disclosure argument against it is that anyone holding the link can then read
 * the person's email and number off the screen. That is already true of the same
 * link on the same surface: the landing panel shows a recognised lead their
 * booked time, their advisor and their whole phone number (#2213), and the
 * confirmation screen names the email the invite went to. Filling the form
 * discloses nothing to the holder of a link that the holder of that link cannot
 * already read one screen earlier, so the choice here is between two screens
 * that disclose and one of them also making the lead retype it.
 *
 * What is pinned here is the part that decides whether that is safe and correct:
 * the LINK always wins over the record, per field; a value is only taken from a
 * booking that still holds one (retention nulls them, #1071); and nothing is
 * invented when neither side has anything.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-booker-known-lead.ts
 */
import {
  knownContactFromBookings,
  attendeeForLanding,
  type KnownContactRow,
} from "../src/lib/booking/known-lead.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function row(over: Partial<KnownContactRow> & { id: string }): KnownContactRow {
  return {
    created_at: "2026-01-01T00:00:00.000Z",
    attendee_name: null,
    attendee_first_name: null,
    attendee_email: null,
    attendee_phone: null,
    ...over,
  };
}

// ------------------------------------------------- what Slate already knows

{
  const known = knownContactFromBookings([
    row({
      id: "a",
      created_at: "2026-03-01T00:00:00.000Z",
      attendee_name: "Dana Lead",
      attendee_email: "dana@example.com",
      attendee_phone: "+12035615295",
    }),
  ]);
  eq(known?.name ?? null, "Dana Lead", "the name on their booking");
  eq(known?.email ?? null, "dana@example.com", "the email on their booking");
  eq(known?.phone ?? null, "+12035615295", "the number on their booking");
}

{
  // Newest first, whatever order the rows arrive in. A read that declares no
  // order carries none (L343), so the choice is made here rather than assumed
  // from the query.
  const known = knownContactFromBookings([
    row({ id: "old", created_at: "2025-01-01T00:00:00.000Z", attendee_email: "old@example.com" }),
    row({ id: "new", created_at: "2026-06-01T00:00:00.000Z", attendee_email: "new@example.com" }),
  ]);
  eq(known?.email ?? null, "new@example.com", "the most recent booking's email wins");
}

{
  // Per FIELD, not per row. An API booking carries an external id and often no
  // name; dropping the name because the newest row happens not to carry one
  // would hand the lead an empty field while Slate still holds the answer.
  const known = knownContactFromBookings([
    row({ id: "new", created_at: "2026-06-01T00:00:00.000Z", attendee_phone: "+12035615295" }),
    row({ id: "old", created_at: "2025-01-01T00:00:00.000Z", attendee_name: "Dana Lead" }),
  ]);
  eq(known?.phone ?? null, "+12035615295", "the newest number");
  eq(known?.name ?? null, "Dana Lead", "and the newest name, from an older booking");
}

{
  // Same instant on two rows: `id` breaks the tie into a total order, so the
  // answer is the same on every run rather than whatever the reader returned
  // (L419).
  const at = "2026-06-01T00:00:00.000Z";
  const forwards = knownContactFromBookings([
    row({ id: "aaa", created_at: at, attendee_email: "aaa@example.com" }),
    row({ id: "bbb", created_at: at, attendee_email: "bbb@example.com" }),
  ]);
  const backwards = knownContactFromBookings([
    row({ id: "bbb", created_at: at, attendee_email: "bbb@example.com" }),
    row({ id: "aaa", created_at: at, attendee_email: "aaa@example.com" }),
  ]);
  eq(forwards?.email ?? null, backwards?.email ?? null, "a tie resolves the same way both ways round");
}

{
  // #1071 redacts an aged booking's contact columns to null. A redacted row
  // holds nothing, and nothing is what it must contribute: a form filled from a
  // record retention has already cleared would hand back what was deleted.
  eq(
    knownContactFromBookings([row({ id: "redacted", attendee_name: null, attendee_email: null, attendee_phone: null })]),
    null,
    "a redacted booking teaches this nothing",
  );
}

{
  // A stored column holding spaces arrives through the API and through an
  // import, and " " is not a name, an address or a number anybody can use. Same
  // rule the landing panel's phone already applies (#2213).
  eq(
    knownContactFromBookings([row({ id: "blank", attendee_name: "  ", attendee_email: " ", attendee_phone: "   " })]),
    null,
    "whitespace is not a value",
  );
  const trimmed = knownContactFromBookings([row({ id: "padded", attendee_name: "  Dana Lead " })]);
  eq(trimmed?.name ?? null, "Dana Lead", "a padded value is trimmed rather than dropped");
}

eq(knownContactFromBookings([]), null, "no bookings at all teaches this nothing");

// ------------------------------------------------- what reaches the form

{
  // The link wins, per field. It carries what the landing page believes TODAY;
  // the booking carries what was true whenever it was made.
  const merged = attendeeForLanding(
    { name: "Dana Corrected", email: "", phone: "" },
    { name: "Dana Lead", firstName: null, email: "dana@example.com", phone: "+12035615295" },
  );
  eq(merged.name, "Dana Corrected", "the link's name beats the stored one");
  eq(merged.email, "dana@example.com", "and the record fills the email the link left out");
  eq(merged.phone, "+12035615295", "and the number");
}

{
  // A link field holding only spaces is a field the link did not answer.
  const merged = attendeeForLanding(
    { name: "   ", email: "  ", phone: " " },
    { name: "Dana Lead", firstName: null, email: "dana@example.com", phone: "+12035615295" },
  );
  eq(merged.name, "Dana Lead", "a blank link field falls through to the record");
}

{
  // Nothing known, nothing invented: this is the empty form every unrecognised
  // lead still gets, unchanged.
  const merged = attendeeForLanding({ name: "", email: "", phone: "" }, null);
  eq(merged.name, "", "no name is invented");
  eq(merged.email, "", "no email is invented");
  eq(merged.phone, "", "no number is invented");
}

{
  // The record is consulted for the fields the link left out even when it
  // answered one of them, which is the case the pilot link actually produces.
  const merged = attendeeForLanding(
    { name: "", email: "", phone: "(203) 561-5295" },
    { name: "Dana Lead", firstName: null, email: "dana@example.com", phone: "+19999999999" },
  );
  eq(merged.phone, "(203) 561-5295", "the link's number is the one the lead is about to be called on");
  eq(merged.name, "Dana Lead", "and the rest still comes from the record");
  assert(merged.email === "dana@example.com", "including the email");
}

// ------------------------------------------------- the answered first name (#2835)

{
  // The first name the lead ANSWERED travels with the name it was answered
  // beside, so the form can show "Mary Jo" / "Smith" rather than splitting the
  // joined name back into "Mary" / "Jo Smith".
  const known = knownContactFromBookings([
    row({ id: "a", attendee_name: "Mary Jo Smith", attendee_first_name: "Mary Jo" }),
  ]);
  eq(known?.name ?? null, "Mary Jo Smith", "the joined name");
  eq(known?.firstName ?? null, "Mary Jo", "and the first name as answered");
  const merged = attendeeForLanding({ name: "", email: "", phone: "" }, known);
  eq(merged.firstName, "Mary Jo", "which reaches the form beside the name");
}

{
  // It comes from the SAME booking as the name, never a neighbour's. A newer
  // booking carrying a name with no answered first name must not be paired with
  // an older booking's first name for a different name.
  const known = knownContactFromBookings([
    row({ id: "new", created_at: "2026-06-01T00:00:00.000Z", attendee_name: "Robin New" }),
    row({ id: "old", created_at: "2025-01-01T00:00:00.000Z", attendee_name: "Mary Jo Smith", attendee_first_name: "Mary Jo" }),
  ]);
  eq(known?.name ?? null, "Robin New", "the newest name");
  eq(known?.firstName ?? null, null, "and no first name, because that booking answered none");
}

{
  // A stored first name that disagrees with the name beside it is not one fact
  // with it, so it is not carried at all.
  const known = knownContactFromBookings([
    row({ id: "a", attendee_name: "Mary Jo Smith", attendee_first_name: "Robin" }),
  ]);
  eq(known?.firstName ?? null, null, "a disagreeing first name is dropped");
  eq(attendeeForLanding({ name: "", email: "", phone: "" }, known).firstName, "", "and the form gets none");
}

{
  // The first name is never a disclosure of its own: with no name there is
  // nothing it can be carried beside, and a row holding only a first name
  // teaches the form nothing.
  eq(
    knownContactFromBookings([row({ id: "a", attendee_first_name: "Mary Jo" })]),
    null,
    "a first name with no name is not a known contact",
  );
}

{
  // The link's name wins, and the stored first name follows it only when it
  // still agrees with the name the form will show.
  const known = { name: "Mary Jo Smith", firstName: "Mary Jo", email: null, phone: null };
  eq(
    attendeeForLanding({ name: "Mary Jo Smith", email: "", phone: "" }, known).firstName,
    "Mary Jo",
    "a link carrying the same name keeps the answered first name",
  );
  eq(
    attendeeForLanding({ name: "Robin New", email: "", phone: "" }, known).firstName,
    "",
    "a link carrying a different name drops it",
  );
}

finish();

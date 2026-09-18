/**
 * What Slate already knows about a lead its landing link identifies (#2208).
 *
 * `/booking/{salesforceId}` and `/book?external_id=` both resolve the person by
 * the id in the link and ask whether they already have a call (#2166). That is
 * the only thing the identity was ever used for, so a recognised lead with no
 * call was handed an empty Name, Email and Phone form and asked to retype what
 * Slate was holding two tables away. The pilot link carries none of the three in
 * its query string, so in practice that was every recognised lead.
 *
 * ## The disclosure decision #2208 asked for, settled before this was built
 *
 * Filling the form means anyone holding the link can read that person's email
 * and phone number off the screen. That is already true of the same link on the
 * same surface: a recognised lead's landing panel names their booked time, their
 * advisor and their whole phone number (#2213), and the confirmation screen
 * names the address the invite went to. So this discloses nothing to the holder
 * of a link that the holder of that link could not already read one screen
 * earlier, and the choice was never between disclosing and not: it was between
 * disclosing on one screen and disclosing on one screen while also making the
 * lead retype it.
 *
 * ## Two rules that keep it honest
 *
 * The LINK wins, per field. It carries what the landing page believes today; a
 * booking carries what was true whenever it was made.
 *
 * And nothing here is presented as a recorded fact. Every value lands in an
 * editable field the lead reads before they commit, and a prefilled full name is
 * SPLIT in front of them by `splitName` (#2362), so an inference somebody can
 * see and change is not one presented as fact (L192). No sentence is added
 * saying where the values came from: that would be a sentence explaining the
 * interface back to the reader, which is the class #2204 deleted from this same
 * step (L604).
 *
 * Pure, with no `@/` imports, so the node suite can drive it.
 */

/** The columns a booking carries about the person who made it. */
export interface KnownContactRow {
  id: string;
  created_at: string;
  attendee_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
}

/** What Slate holds, with a null per fact it does not hold. */
export interface KnownContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** A value, or nothing. A column holding spaces arrives through the API and
 *  through an import, and " " is not a name, an address or a number anybody can
 *  use, so it reads as absent exactly as the landing panel's phone does (#2213). */
function value(raw: string | null | undefined): string | null {
  return (raw ?? "").trim() || null;
}

/**
 * The most recent thing Slate knows about each fact, or null when it knows none.
 *
 * Newest first, decided HERE rather than inherited from whatever order the read
 * returned (L343), and ties broken on `id` so the answer is the same on every
 * run rather than whichever row the database happened to hand over first (L419).
 *
 * Per FIELD, not per row. A booking made through the direct API carries an
 * external id and often no name, so taking the newest row wholesale would hand
 * the lead an empty field while Slate still held the answer on the booking
 * before it. Retention (#1071) nulls all three columns together on an aged
 * booking, so a redacted row contributes nothing and cannot resurrect a value
 * that was deliberately cleared.
 */
export function knownContactFromBookings(rows: KnownContactRow[]): KnownContact | null {
  const newestFirst = [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  const first = (pick: (r: KnownContactRow) => string | null) => {
    for (const r of newestFirst) {
      const v = value(pick(r));
      if (v) return v;
    }
    return null;
  };
  const contact: KnownContact = {
    name: first((r) => r.attendee_name),
    email: first((r) => r.attendee_email),
    phone: first((r) => r.attendee_phone),
  };
  if (!contact.name && !contact.email && !contact.phone) return null;
  return contact;
}

/** What the landing link itself carried, straight off the query string. */
export interface LinkAttendee {
  name: string;
  email: string;
  phone: string;
}

/**
 * What the details form starts with: the link's answer per field, and Slate's
 * own record wherever the link answered nothing.
 *
 * A link field holding only spaces is a field the link did not answer, so it
 * falls through rather than blanking a fact Slate holds.
 */
export function attendeeForLanding(
  link: LinkAttendee,
  known: KnownContact | null,
): LinkAttendee {
  return {
    name: value(link.name) ?? known?.name ?? "",
    email: value(link.email) ?? known?.email ?? "",
    phone: value(link.phone) ?? known?.phone ?? "",
  };
}

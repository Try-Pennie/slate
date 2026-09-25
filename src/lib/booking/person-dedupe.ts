/**
 * Person-level dedupe / auto-reschedule decision for the direct booking API
 * (#357) — the heart of "one active appointment per person". Pure (relative
 * value imports, type-only "@/" erased) so it unit-tests under
 * `node --experimental-strip-types`; the service wires the lookup + actions.
 *
 * Match grading, and the locked rule it enforces:
 *  - strong  : a supplied strong id sits in EITHER id column -> auto-reschedule on a new time
 *  - medium  : BOTH email AND phone match            -> auto-reschedule on a new time
 *  - weak    : only email OR only phone matches      -> NEVER auto-move; return the
 *              existing appointment for the bot to confirm (unless it passes
 *              confirmReschedule, i.e. it already asked the lead)
 * A same-instant rebook always dedupes regardless of strength (same instant =
 * the same booking intent). The weak tier guards against silently moving the
 * wrong person on a shared household phone or a recycled id.
 */
import type { Booking } from "@/lib/db/types";
import { toE164 } from "../phone.ts";
import { bookingMatchesLookupIds, strongIdsOf } from "./lookup-identity.ts";

export interface PersonIdentity {
  externalId: string | null;
  salesforceId: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * Which WORLD a person read is asked in (#2660): the test one, or the real one.
 *
 * A booking on a test bucket (the canary's, or the public test bucket a partner
 * books from their own site) and a booking on a real bucket are not the same
 * person's calls even when the identity matches: a tester who types a real lead's
 * id must never be shown that lead's call, and a test booking under an address
 * must never refuse the real lead who owns it. So every read that grades a
 * person is scoped to the world of the bucket in play, never left to the
 * identity alone. `bookings` has no flag of its own; the world is the bucket's
 * `is_test`, joined at the read.
 */
export interface PersonWorld {
  isTest: boolean;
}

export type MatchStrength = "strong" | "medium" | "weak";

export interface PersonMatch {
  booking: Booking;
  strength: MatchStrength;
}

export type BookingDecision =
  | { action: "create" }
  | { action: "dedupe"; booking: Booking }
  | { action: "reschedule"; booking: Booking }
  | { action: "confirm_required"; booking: Booking };

const normEmail = (e: string | null): string | null => {
  const v = (e ?? "").trim().toLowerCase();
  return v.length > 0 ? v : null;
};

/** How strongly `booking` belongs to the person in `identity`, or null if not. */
function matchStrength(
  identity: PersonIdentity,
  booking: Booking,
): MatchStrength | null {
  // A strong id is ONE value that may sit in EITHER column (#2663, the rule the
  // lookup took in #2657). An embed booking stores the lead id in salesforce_id
  // with external_id null, so a column to column match graded a caller sending
  // only externalId as a stranger and booked them a second call.
  if (bookingMatchesLookupIds(booking, personStrongIds(identity))) return "strong";

  const idEmail = normEmail(identity.email);
  const bkEmail = normEmail(booking.attendee_email);
  const emailMatch = idEmail !== null && idEmail === bkEmail;

  const idPhone = toE164(identity.phone);
  const bkPhone = toE164(booking.attendee_phone);
  const phoneMatch = idPhone !== null && idPhone === bkPhone;

  if (emailMatch && phoneMatch) return "medium";
  if (emailMatch || phoneMatch) return "weak";
  return null;
}

/** The strong ids a person read was given, as one set (trimmed, blanks dropped).
 *  The fetch and the grader both use it, so they cannot disagree about which ids
 *  were supplied. */
export function personStrongIds(identity: PersonIdentity): string[] {
  return strongIdsOf([identity.externalId, identity.salesforceId]);
}

const RANK: Record<MatchStrength, number> = { strong: 3, medium: 2, weak: 1 };

/**
 * Best existing-booking match for the person across the active candidates. Picks
 * the strongest match; ties break to the earliest-starting booking (their
 * current appointment). Returns null when no candidate is the same person.
 */
export function findPersonMatch(
  identity: PersonIdentity,
  candidates: Booking[],
): PersonMatch | null {
  let best: PersonMatch | null = null;
  for (const booking of candidates) {
    const strength = matchStrength(identity, booking);
    if (!strength) continue;
    if (
      !best ||
      RANK[strength] > RANK[best.strength] ||
      (RANK[strength] === RANK[best.strength] &&
        Date.parse(booking.starts_at) < Date.parse(best.booking.starts_at))
    ) {
      best = { booking, strength };
    }
  }
  return best;
}

/**
 * Decide what to do with an incoming booking given the person's best existing
 * match. `confirmReschedule` = the bot already asked the lead, so a weak match
 * may move too.
 */
export function decidePersonBooking(input: {
  startIso: string;
  match: PersonMatch | null;
  confirmReschedule: boolean;
}): BookingDecision {
  const { startIso, match, confirmReschedule } = input;
  if (!match) return { action: "create" };

  // Same instant as their existing appointment -> the same booking intent.
  if (Date.parse(match.booking.starts_at) === Date.parse(startIso)) {
    return { action: "dedupe", booking: match.booking };
  }

  const highConfidence = match.strength === "strong" || match.strength === "medium";
  if (highConfidence || confirmReschedule) {
    return { action: "reschedule", booking: match.booking };
  }
  return { action: "confirm_required", booking: match.booking };
}

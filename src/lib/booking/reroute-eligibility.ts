import { matchesCriteria } from "@/lib/availability/match";
import type { Attributes, Criteria } from "@/lib/db/types";

/**
 * The per-booking eligibility predicate for the reroute-on-ineligibility feature (#3582,
 * Phase 1).
 *
 * "Does this agent still serve a booking whose bucket has these criteria?" It mirrors the
 * shipped pool resolver `agentIdsFromPool` for ONE agent, deliberately built on the SAME
 * `matchesCriteria` rather than a second copy of the rule (L263, L342): a manual member of
 * the booking's bucket serves it regardless of attributes, and otherwise the agent must
 * still match the bucket's criteria. `scripts/test-reroute-eligibility.ts` pins the two to
 * agree across shapes, so the reroute trigger can never judge eligibility differently from
 * the booker itself.
 */
export function agentStillServes(
  attributes: Attributes | null | undefined,
  criteria: Criteria | null | undefined,
  isManualMember: boolean,
): boolean {
  if (isManualMember) return true;
  return matchesCriteria(attributes, criteria);
}

/** One of an agent's upcoming bookings, with everything the decision needs about the
 *  booking's OWN bucket. `kind` is the booking kind; an `agent_link` booking (the lead
 *  chose the advisor by name) is never auto-rerouted on a demotion. */
export interface RerouteCandidate {
  bookingId: string;
  kind: string;
  /** The criteria of the booking's own bucket. */
  criteria: Criteria | null;
  /** Whether the agent is a manual member of that bucket (then attributes never matter). */
  isManualMember: boolean;
}

/**
 * Which of an agent's upcoming bookings must reroute after an eligibility change (#3582,
 * Phase 2). Pure, so `scripts/test-reroute-eligibility.ts` drives every branch.
 *
 * A booking reroutes ONLY on a CONFIRMED NARROWING: the agent served it under the `before`
 * attributes and no longer serves it under the `after` attributes. Two fail-safes that keep
 * a transient or incomplete roster read from permanently moving a real customer:
 *
 *  - If EITHER snapshot is null/undefined (unknown, e.g. a failed or partial Twilio read),
 *    nothing reroutes. The caller passes null for "could not read", never an empty object,
 *    so a genuine empty tag set ({} = read, no tags) is still a confirmed narrowing while an
 *    unread one is not (L214, L50). A null attribute must never be fed to `matchesCriteria`
 *    and scored as "ineligible".
 *  - An `agent_link` booking never reroutes: the lead asked for that specific advisor.
 *    Nor does a `staff_placed` one (#4202): it sits on the placeholder for Regal to hand on.
 *
 * A widening (an upgrade) reroutes nothing, because the agent still serves everything they
 * did before. A manual member's booking never reroutes, because membership, not attributes,
 * decides it.
 */
export function bookingsToReroute(
  before: Attributes | null | undefined,
  after: Attributes | null | undefined,
  bookings: RerouteCandidate[],
): string[] {
  if (before == null || after == null) return [];
  return bookings
    // #4202: nor a call placed on the placeholder, which Regal hands on itself.
    .filter((b) => b.kind !== "agent_link" && b.kind !== "staff_placed")
    .filter(
      (b) =>
        agentStillServes(before, b.criteria, b.isManualMember) &&
        !agentStillServes(after, b.criteria, b.isManualMember),
    )
    .map((b) => b.bookingId);
}

/**
 * The FILTERED demotion snapshot (#3582, Phase 4): of an agent's upcoming bookings, the ones
 * they no longer serve under their CURRENT attributes, which is exactly the set a confirmed
 * demotion must move. Re-read at sweep time (the caller re-snapshots) so a booking that
 * landed during the debounce is judged by the same rule.
 *
 * Unlike `coverageBookings` (every upcoming booking, correct only for a FULL pool exit) this
 * keeps only the bookings in the pools the agent LOST, so a partial demotion leaves the
 * still-served bookings alone. It shares `agentStillServes` with `bookingsToReroute` and the
 * booker's own pool resolver, so a snapshot can never move a booking the booker would still
 * have offered the agent (L263, L342).
 *
 * The same two fail-safes as `bookingsToReroute`: a null/undefined (unknown) attribute set
 * moves NOBODY, so a failed roster read can never mass-reroute (L214, L50); an `agent_link`
 * booking is never moved, because the lead chose that advisor by name. A manual member serves
 * every booking in their bucket, so none of theirs is ever in the snapshot.
 */
export function unservedBookingIds(
  attributes: Attributes | null | undefined,
  bookings: RerouteCandidate[],
): string[] {
  if (attributes == null) return [];
  return bookings
    // #4202: nor a call placed on the placeholder, which Regal hands on itself.
    .filter((b) => b.kind !== "agent_link" && b.kind !== "staff_placed")
    .filter((b) => !agentStillServes(attributes, b.criteria, b.isManualMember))
    .map((b) => b.bookingId);
}
